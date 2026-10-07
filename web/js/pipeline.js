/**
 * 管线固定功能状态 —— 移植自 3b1b/manim 的 manimlib/renderer/pipeline.py
 *
 * 上游把「一次绘制除了用哪个模块、读哪些数据之外的全部行为」压成一个不可变的值
 * （PipelineState），再按这个值缓存管线对象。WebGPU 会把 depth / stencil / blend
 * 这些状态烘进管线里，所以只能这么做：状态一变，管线就得重建。
 *
 * ── 填充一个路径要三趟（见 fill.wgsl 与 renderer/drawing.py 的 VDrawing.draw_fill）──
 *   WINDING_COUNT  把填充三角形只写进模板缓冲：正面 +1、背面 -1（wrap）。
 *                  正/背面就是三角形投影到屏幕后的有向面积的正负，于是每个像素上
 *                  留下的就是路径绕它的**绕数**，完全不需要对图形做三角剖分。
 *   FILL_BORDER    只在模板 == 0（形状之外）的地方，用描边着色器沿路径画一圈填充色。
 *                  模板测试是全有或全无的，填充的边缘抗锯齿就靠这一圈。
 *   WINDING_COVER  在模板 != 0 处把同样的三角形再画一遍，这是真正上色的一趟；
 *                  画的同时把模板清零，留给同一帧后面的绘制。
 *
 * 这三趟之所以成立，是因为一次填充只覆盖一个 mobject：几段绕数混在一起会把区域并成一块。
 */

/** 深度与模板共用一张纹理（上游 DEPTH_STENCIL_FORMAT） */
export const DEPTH_STENCIL_FORMAT = 'depth24plus-stencil8';

/** 什么都不改：测试失败 / 深度失败 / 通过，模板值都原样保留 */
export const KEEP = Object.freeze(['keep', 'keep', 'keep']);

/**
 * 颜色通道照常混合；alpha 通道直接取源值，
 * 这样把半透明的图形画到不透明背景上，背景依然是不透明的，
 * 不会被反过来"吃掉"自己的 alpha。
 */
export const BLEND = Object.freeze({
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
});

export class PipelineState {
    /**
     * @param {object} [spec]
     * @param {boolean} [spec.depthTest]  是否用深度决定遮挡
     * @param {boolean} [spec.depthWrite] 是否写深度
     * @param {boolean} [spec.colorWrite] 是否写颜色（模板那趟不写）
     * @param {string}  [spec.stencilCompare] 模板比较函数，'always' 表示不参与判断
     * @param {Array}   [spec.stencilOps] [正面, 背面]，各是 [测试失败, 深度失败, 通过] 三个操作
     */
    constructor({
        depthTest = false,
        depthWrite = true,
        colorWrite = true,
        depthCompare = 'less',
        stencilCompare = 'always',
        stencilOps = [KEEP, KEEP],
    } = {}) {
        this.depthTest = depthTest;
        this.depthWrite = depthWrite;
        this.colorWrite = colorWrite;
        this.depthCompare = depthCompare;
        this.stencilCompare = stencilCompare;
        this.stencilOps = stencilOps;
    }

    /** 作为管道描述符里的 depthStencil 字段 */
    descriptor() {
        const face = ([failOp, depthFailOp, passOp]) => ({
            compare: this.stencilCompare,
            failOp,
            depthFailOp,
            passOp,
        });
        return {
            format: DEPTH_STENCIL_FORMAT,
            depthWriteEnabled: this.depthWrite,
            depthCompare: this.depthTest ? this.depthCompare : 'always',
            stencilFront: face(this.stencilOps[0]),
            stencilBack: face(this.stencilOps[1]),
            stencilReadMask: 0xFF,
            stencilWriteMask: 0xFF,
        };
    }

    get colorWriteMask() {
        return this.colorWrite ? 0xF : 0;
    }

    /** 管线缓存键：所有字段都一致才共用一条管线 */
    get key() {
        return [
            this.depthTest ? 1 : 0, this.depthWrite ? 1 : 0, this.colorWrite ? 1 : 0,
            this.depthCompare,
            this.stencilCompare, ...this.stencilOps[0], ...this.stencilOps[1],
        ].join('|');
    }

    /** 只改深度测试一项（对应上游 PipelineState.resolved） */
    withDepthTest(depthTest) {
        if (this.depthTest === depthTest) return this;
        return new PipelineState({ ...this, depthTest });
    }
}

/** 普通绘制：模板不参与判断，深度测试关（2D 场景的默认） */
PipelineState.DEFAULT = new PipelineState();

/**
 * 3D 不透明几何：开深度测试（less）+ 深度写入，让 z 决定谁挡住谁。
 *
 * project_point.wgsl 写出的裁剪空间 z 随「点到相机的距离」单调递增，
 * 所以 near < far，用 less 正是正确的遮挡关系。
 * 2D 场景里所有点 z 相同（= 0.5），开 depthTest 会让后画的统统被判失败，
 * 所以 2D 模块一律用 DEFAULT。
 */
PipelineState.DEPTH = new PipelineState({ depthTest: true, depthWrite: true });

/**
 * 3D 线框：压在曲面**表面**上的一条线，深度与曲面相同。
 *
 * 用 less-equal 而非 less —— 线框的深度是由自己的几何插值出来的，
 * 与曲面在同一处难免差之毫厘，用 less 会大半被判失败而断续；
 * 同时不写深度（depthWrite: false），免得线框把后面的东西挡住。
 */
PipelineState.OVERLAY = new PipelineState({
    depthTest: true,
    depthWrite: false,
    depthCompare: 'less-equal',
});

/** 填充第一趟：只数绕数 */
PipelineState.WINDING_COUNT = new PipelineState({
    depthTest: false,
    depthWrite: false,
    colorWrite: false,
    stencilOps: [
        ['keep', 'increment-wrap', 'increment-wrap'],
        ['keep', 'decrement-wrap', 'decrement-wrap'],
    ],
});

/** 填充第二趟：只在模板为 0（形状之外）处画边框，给填充边缘抗锯齿 */
PipelineState.FILL_BORDER = new PipelineState({
    stencilCompare: 'equal',
    stencilOps: [KEEP, KEEP],
});

/** 填充第三趟：在模板非 0 处上色，并把模板清零 */
PipelineState.WINDING_COVER = new PipelineState({
    stencilCompare: 'not-equal',
    stencilOps: [['keep', 'zero', 'zero'], ['keep', 'zero', 'zero']],
});
