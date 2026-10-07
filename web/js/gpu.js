/**
 * WebGPU 渲染核心 —— 移植自3b1b/manim 的 manimlib/renderer/
 *
 * 对应关系：
 *   gpu.py           -> Gpu 类（设备、渲染通道、绘制命令）
 *   pipeline.py      -> PipelineState + build_pipeline（见 pipeline.js）
 *   shared_buffer.py -> 共享顶点缓冲（随规模翻倍增长）
 *   texture.py       -> 离屏纹理
 *
 * 关键设计（沿用上游）：
 *   - 顶点数据放在 storage buffer，着色器自己按 flat float 数组索引，
 *     不走 vertex attribute（见read_data.wgsl）
 *   - 一帧只开一个渲染通道：所有绘制都在里面，且都带 depth-stencil 附件
 *     （填充数绕数要用模板缓冲）
 *   - 一次绘制 = 一条管线 + 一块 mobject uniform + 一段记录缓冲
 *
 * ── 图层（layer）──────────────────────────────────────────────
 * 上游每个 mobject 在共享缓冲里占一段，绘制时用 dynamic offset 指过去。
 * 本项目把共享缓冲简化成 N 个"图层槽"：每个槽有自己的一块 mobject uniform
 * 缓冲和一段记录缓冲，模块按绘制顺序往槽里填。
 * 一个模块需要几层由它自己声明（见 setMobjectFields 的第二个参数）。
 * 例：函数绘图器用 3 层 —— 背景（网格/轴）、填充、前景（曲线/轮廓），
 * 这样填充就压在网格之上、曲线之下。
 */

import { buildShaderCode } from './shader-loader.js';
import { makeMobjectBlock, FRAME_STRUCT } from './uniform-block.js';
import { Camera } from './camera.js';
import { PipelineState, BLEND, DEPTH_STENCIL_FORMAT } from './pipeline.js';

/** 顶点记录缓冲至少留这么多字节的余量：
 *  着色器读"最后一段曲线之后"的记录是常态（如边框给未闭合子路径补的封闭弦），
 *  越界读会被钳成 0，但缓冲本身得够大，不然读出来的一直是 0 也不至于出错，
 *  这里留出余量只是让行为可预期（读到的是我们写的 0 填充，而非随机内存）。 */
const RECORD_HEADROOM = 16 * 1024;

export class Gpu {
    constructor() {
        this.device = null;
        this.context = null;
        this.format = 'bgra8unorm';
        this.canvas = null;
        this.camera = new Camera();

        this.frameBindGroupLayout = null;
        this.frameUniform = null;
        this.frameBuffer = null;
        this.frameBindGroup = null;

        this.mobjectLayout = null;
        this.recordLayout = null;
        this.pipelineLayout = null;

        // 图层槽：{ block, buffer, bindGroup, recordBuffer, recordCapacity, recordBindGroup }
        this.layers = [];

        this.pipelines = new Map();
        this.width = 1;
        this.height = 1;

        this.depthStencilTexture = null;
        this.depthStencilView = null;
        this.depthStencilSize = [0, 0];
    }

    /**
     * 初始化设备与画布。
     * @throws 当 navigator.gpu 不存在时抛出，由调用方给出「安全上下文」提示
     */
    async init(canvas) {
        if (typeof navigator === 'undefined' || !navigator.gpu) {
            const err = new Error('NO_WEBGPU');
            err.code = 'NO_WEBGPU';
            throw err;
        }
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) {
            const err = new Error('NO_ADAPTER');
            err.code = 'NO_ADAPTER';
            throw err;
        }
        this.adapter = adapter;
        this.device = await adapter.requestDevice();
        this.adapterInfo = adapter.info ?? {};
        this.limits = adapter.limits;

        this.canvas = canvas;
        this.context = canvas.getContext('webgpu');
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: 'opaque',
        });

        this.#createLayouts();
        return this;
    }

    #createLayouts() {
        const V = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
        this.frameBindGroupLayout = this.device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: V, buffer: { type: 'uniform' } }],
        });
        this.mobjectLayout = this.device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: V, buffer: { type: 'uniform' } }],
        });
        this.recordLayout = this.device.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'read-only-storage' },
            }],
        });

        this.pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.frameBindGroupLayout, this.mobjectLayout, this.recordLayout],
        });
    }

    resize(width, height) {
        this.width = Math.max(1, Math.floor(width));
        this.height = Math.max(1, Math.floor(height));
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.camera.resize(this.width, this.height);
    }

    // ── 帧 uniform ────────────────────────────────

    /** 帧 uniform 每帧重建并绑定一次。 */
    updateFrameUniform() {
        if (!this.frameBuffer) {
            this.frameUniform = this.camera.update();
            this.frameBuffer = this.frameUniform.createBuffer(this.device);
            this.frameBindGroup = this.device.createBindGroup({
                layout: this.frameBindGroupLayout,
                entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
            });
        }
        this.camera.update().upload(this.device, this.frameBuffer);
    }

    // ── 图层 ──────────────────────────────────────

    /**
     * 重建 mobject uniform 布局与全部图层槽。
     * @param {Array} fields 字段描述表（uniform-block.js 的格式）
     * @param {number} [count] 图层数
     */
    setMobjectFields(fields, count = 1) {
        this.mobjectFields = fields;
        this.layers = [];
        for (let i = 0; i < count; i++) {
            const block = makeMobjectBlock(fields, 1);
            const buffer = block.createBuffer(this.device);
            const bindGroup = this.device.createBindGroup({
                layout: this.mobjectLayout,
                entries: [{ binding: 0, resource: { buffer } }],
            });
            this.layers.push({
                block, buffer, bindGroup,
                recordBuffer: null, recordCapacity: 0, recordBindGroup: null,
            });
        }
        return this.layers[0].block;
    }

    /** 第 i 层的 { block, buffer, bindGroup, ... } */
    layer(i = 0) {
        return this.layers[i];
    }

    /** 第 0 层（只有一个图层的模块直接用这两个） */
    get mobject() {
        return this.layers[0]?.block ?? null;
    }

    get mobjectBuffer() {
        return this.layers[0]?.buffer ?? null;
    }

    /** 供着色器取 .decl（纯成员声明）与 .source（含 struct 与 @group(1) 绑定） */
    get mobjectBlock() {
        return this.layers[0]?.block ?? null;
    }

    /**
     * 上传某一层的顶点记录。上游用共享缓冲并按需翻倍，此处沿用该策略。
     * @param {Float32Array} data 每条记录 12 个 float（见 vmobject.js 的布局）
     * @param {number} layerIndex
     */
    uploadRecords(data, layerIndex = 0) {
        const layer = this.layers[layerIndex];
        if (!layer || !data) return;
        const needed = data.byteLength;
        if (needed === 0) {
            this.#ensureRecordBuffer(layer, RECORD_HEADROOM);
            return;
        }
        const want = needed + RECORD_HEADROOM;
        this.#ensureRecordBuffer(layer, want);
        this.device.queue.writeBuffer(layer.recordBuffer, 0, data);
    }

    #ensureRecordBuffer(layer, want) {
        if (layer.recordBuffer && layer.recordCapacity >= want) return;
        let size = Math.max(4096, layer.recordCapacity || 4096);
        while (size < want) size *= 2;
        layer.recordBuffer?.destroy?.();
        layer.recordBuffer = this.device.createBuffer({
            size,
            // COPY_SRC 便于调试时读回顶点数据
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        layer.recordCapacity = size;
        layer.recordBindGroup = this.device.createBindGroup({
            layout: this.recordLayout,
            entries: [{ binding: 0, resource: { buffer: layer.recordBuffer } }],
        });
    }

    // ── 管线 ──────────────────────────────────────

    /**
     * 编译一个着色器并缓存管线。
     * 管线的固定功能状态由 state 决定（见 pipeline.js），同一份源码的不同状态
     * 各自是一条管线 —— 填充的三趟就是这么来的。
     *
     * @param {string} filename 上游 shaders/ 下的文件名
     * @param {object} options dataLayout / uniformMembers / state / replace
     */
    async loadPipeline(filename, options = {}) {
        const state = options.state ?? PipelineState.DEFAULT;
        const replace = options.replace ?? null;
        const key = [
            filename,
            JSON.stringify(options.dataLayout ?? null),
            // uniform 成员声明也进键：同一份源码在不同 mobject 类型下编译出的模块并不相同
            options.uniformMembers ?? '',
            state.key,
            replace ? JSON.stringify(replace) : '',
        ].join('|');
        if (this.pipelines.has(key)) return this.pipelines.get(key);

        // uniformMembers 来自 makeMobjectBlock().source，含 struct 声明与 @group(1) 绑定
        const code = await buildShaderCode(filename, {
            dataLayout: options.dataLayout ?? null,
            uniformMembers: options.uniformMembers ?? '',
            replace,
            onProgress: options.onProgress,
        });

        const module = this.device.createShaderModule({ code, label: filename });
        const info = await module.getCompilationInfo();
        const errors = info.messages.filter((m) => m.type === 'error');
        if (errors.length) {
            const msg = errors.map((e) => `第 ${e.lineNum} 行: ${e.message}`).join('\n');
            const err = new Error(`着色器编译失败 ${filename}\n${msg}`);
            err.code = 'SHADER_COMPILE';
            err.detail = code;
            throw err;
        }

        const pipeline = this.device.createRenderPipeline({
            // 同一份源码编译出多条管线时（如描边与填充边框），标签要能区分开，
            // 否则着色器报错时看不出是哪一趟挂了
            label: replace ? `${filename} [variant]` : filename,
            layout: this.pipelineLayout,
            vertex: { module, entryPoint: 'vs_main' },
            fragment: {
                module,
                entryPoint: 'fs_main',
                targets: [{
                    format: this.format,
                    blend: BLEND,
                    writeMask: state.colorWriteMask,
                }],
            },
            primitive: { topology: 'triangle-list' },
            depthStencil: state.descriptor(),
        });

        const entry = { pipeline, module, code, state };
        this.pipelines.set(key, entry);
        return entry;
    }

    // ── 深度/模板 ─────────────────────────────────

    /** 深度与模板共用的那张纹理，随画布大小重建 */
    #ensureDepthStencil(width = this.width, height = this.height) {
        if (
            this.depthStencilView
            && this.depthStencilSize[0] === width
            && this.depthStencilSize[1] === height
        ) {
            return this.depthStencilView;
        }
        this.depthStencilTexture?.destroy?.();
        this.depthStencilTexture = this.device.createTexture({
            size: [width, height, 1],
            format: DEPTH_STENCIL_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthStencilView = this.depthStencilTexture.createView();
        this.depthStencilSize = [width, height];
        return this.depthStencilView;
    }

    /**
     * 一帧开头清一次即可：填充的第三趟会把模板清零，
     * 所以同一帧里多个填充不会互相干扰。
     */
    #depthStencilAttachment(view) {
        return {
            view,
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'discard',
            stencilClearValue: 0,
            stencilLoadOp: 'clear',
            stencilStoreOp: 'discard',
        };
    }

    // ── 绘制 ──────────────────────────────────────

    /**
     * 把一串绘制指令写进通道。
     * @param {Array<{entry:object, vertexCount:number, layer?:number}>} draws
     */
    #issue(pass, draws) {
        pass.setStencilReference(0);
        for (const d of draws) {
            const layer = this.layers[d.layer ?? 0];
            if (!d.entry || !layer || !layer.recordBindGroup) continue;
            if (!(d.vertexCount > 0)) continue;
            pass.setPipeline(d.entry.pipeline);
            pass.setBindGroup(0, this.frameBindGroup);
            pass.setBindGroup(1, layer.bindGroup);
            pass.setBindGroup(2, layer.recordBindGroup);
            pass.draw(d.vertexCount, 1, 0, 0);
        }
    }

    /** 提交一帧绘制。 */
    render(draws) {
        if (!this.frameBindGroup || !this.layers.length) return;
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0.2, g: 0.2, b: 0.2, a: 1 },
            }],
            depthStencilAttachment: this.#depthStencilAttachment(this.#ensureDepthStencil()),
        });
        this.#issue(pass, draws);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    /**
     * 离屏渲染并读回像素。
     * 比 canvas.toDataURL() 可靠 —— WebGPU 画布在某些时机抓取会得到空白。
     * @returns {Promise<{pixels: Uint8ClampedArray, width: number, height: number}>}
     */
    async renderToPixels(draws, width = this.width, height = this.height) {
        const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
        const texture = this.device.createTexture({
            size: [width, height, 1],
            format: this.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        const depthStencil = this.device.createTexture({
            size: [width, height, 1],
            format: DEPTH_STENCIL_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        const readback = this.device.createBuffer({
            size: bytesPerRow * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: texture.createView(),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0.2, g: 0.2, b: 0.2, a: 1 },
            }],
            depthStencilAttachment: this.#depthStencilAttachment(depthStencil.createView()),
        });
        this.#issue(pass, draws);
        pass.end();
        encoder.copyTextureToBuffer(
            { texture },
            { buffer: readback, bytesPerRow, rowsPerImage: height },
            [width, height, 1]
        );
        this.device.queue.submit([encoder.finish()]);

        await readback.mapAsync(GPUMapMode.READ);
        const src = new Uint8Array(readback.getMappedRange());
        // 从带padding 的行距转换为紧凑像素
        const pixels = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
            const s = y * bytesPerRow;
            pixels.set(src.subarray(s, s + width * 4), y * width * 4);
        }
        readback.unmap();
        readback.destroy();
        texture.destroy();
        depthStencil.destroy();
        return { pixels, width, height };
    }

    /** 能力报告，用于「关于」面板与环境自检。 */
    describe() {
        const i = this.adapterInfo ?? {};
        return {
            vendor: i.vendor || '未知',
            architecture: i.architecture || '',
            device: i.device || i.description || '',
            format: this.format,
            maxBufferSize: this.limits?.maxBufferSize ?? 0,
            maxTextureDimension2D: this.limits?.maxTextureDimension2D ?? 0,
        };
    }
}
