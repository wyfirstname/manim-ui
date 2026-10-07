/**
 * 分形实验室 —— 首个完整模块
 *
 * 直接使用上游 3b1b/manim 的着色器，零改写：
 *   shaders/mandelbrot_fractal.wgsl  →曼德博集 / 朱利亚集
 *   shaders/newton_fractal.wgsl      → 牛顿迭代法
 *
 * 对应上游 manimlib/mobject/fractals.py 的 PlaneFractal / MandelbrotFractal /
 * JuliaFractal / NewtonFractal / MetaNewtonFractal。
 *
 * 顶点布局：着色器用 4 个记录（矩形的 4 个角），6 个顶点索引进这 4 个记录。
 * 见 inserts/quad_corners.wgsl 的 corners = [0,1,2, 2,1,3]。
 */

import { t } from '../i18n.js';

/** 曼德博/朱利亚共用的 mobject uniform 字段（与上游 uniform_dtype 对应） */
export const FRACTAL_FIELDS = [
    { name: 'is_fixed_in_frame', type: 'f32' },
    { name: 'clip_plane0', type: 'vec4f' },
    { name: 'clip_plane1', type: 'vec4f' },
    { name: 'clip_plane2', type: 'vec4f' },
    { name: 'clip_plane3', type: 'vec4f' },
    { name: 'offset', type: 'vec3f' },
    { name: 'scale_factor', type: 'f32' },
    { name: 'opacity', type: 'f32' },
    { name: 'shading', type: 'vec3f' },
    { name: 'n_steps', type: 'f32' },
    { name: 'mandelbrot', type: 'f32' },
    { name: 'parameter', type: 'vec2f' },
    { name: 'colors', type: 'vec4f', count: 9 },
];

/**
 * 牛顿分形的 uniform 字段。
 *
 * 严格对应上游 newton_fractal.wgsl 里实际引用的 mob.* 字段
 * （用 grep 'mob\.' 提取，避免遗漏）：
 *   coefs[6]  多项式系数（升幂），complex 用 uniform 里的前两个 float 表示
 *   roots[5]  多项式的根
 *   n_roots / n_steps / saturation_factor / black_for_cycles
 *   is_parameter_space / julia_highlight
 * 以及所有分形共有的 offset / scale_factor / colors。
 *
 * 注意 coefs/roots 是 array<vec2f, N>，但 uniform 里数组元素必须 16 字节对齐，
 * 故实际以 array<vec4f, N> 承载、着色器取 .xy（与上游注释一致）。
 */
export const NEWTON_FIELDS = [
    { name: 'is_fixed_in_frame', type: 'f32' },
    { name: 'clip_plane0', type: 'vec4f' },
    { name: 'clip_plane1', type: 'vec4f' },
    { name: 'clip_plane2', type: 'vec4f' },
    { name: 'clip_plane3', type: 'vec4f' },
    { name: 'offset', type: 'vec3f' },
    { name: 'scale_factor', type: 'f32' },
    { name: 'opacity', type: 'f32' },
    { name: 'shading', type: 'vec3f' },
    { name: 'n_steps', type: 'f32' },
    { name: 'saturation_factor', type: 'f32' },
    { name: 'black_for_cycles', type: 'f32' },
    { name: 'n_roots', type: 'f32' },
    { name: 'is_parameter_space', type: 'f32' },
    { name: 'julia_highlight', type: 'f32' },
    { name: 'coefs', type: 'vec4f', count: 6 },
    { name: 'roots', type: 'vec4f', count: 5 },
    { name: 'colors', type: 'vec4f', count: 9 },
];

/** 牛顿法求解 z³ - 1 = 0：系数（升幂）与三个立方根 */
export const NEWTON_CUBIC_MINUS_1 = {
    coefs: [
        [0, 0, 0, 0],   // z^0
        [0, 0, 0, 0],   // z^1
        [0, 0, 0, 0],   // z^2
        [1, 0, 0, 0],   // z^3
        [0, 0, 0, 0],
        [0, 0, 0, 0],
    ],
    roots: [
        [1, 0, 0, 0],
        [-0.5, Math.sqrt(3) / 2, 0, 0],
        [-0.5, -Math.sqrt(3) / 2, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
    ],
    nRoots: 3,
};

/** 上游默认配色（manim 的 colormap，深蓝→青→黄→红） */
export const DEFAULT_COLORS = [
    [0.004, 0.018, 0.2, 1],
    [0.02, 0.2, 0.6, 1],
    [0.0, 0.8, 0.8, 1],
    [0.1, 0.9, 0.2, 1],
    [0.9, 0.9, 0.1, 1],
    [1.0, 0.4, 0.0, 1],
    [0.8, 0.1, 0.2, 1],
    [0.4, 0.0, 0.6, 1],
    [0.0, 0.0, 0.0, 1],
];

/** 顶点的数据布局：每个记录 4 个 float（xyz + 1 填充） */
export const POINT_LAYOUT = {
    itemsize: 16,
    fields: { point: 0 },
};

/**
 * 生成覆盖平面的 4 个角点记录。
 * 上游 PlaneFractal 是一个铺在平面上的矩形，着色器按 plane_point 计算迭代。
 * @param {number} halfW 半宽（场景单位）
 * @param {number} halfH 半高
 */
export function makeQuadRecords(halfW = 4.0, halfH = 4.0) {
    // 顺序必须与 quad_corners.wgsl 一致：左上, 左下, 右上, 右下
    const corners = [
        [-halfW, halfH, 0],
        [-halfW, -halfH, 0],
        [halfW, halfH, 0],
        [halfW, -halfH, 0],
    ];
    const out = new Float32Array(corners.length * 4);
    corners.forEach((c, i) => {
        out[i * 4 + 0] = c[0];
        out[i * 4 + 1] = c[1];
        out[i * 4 + 2] = c[2];
        out[i * 4 + 3] = 0;
    });
    return out;
}

/** 预设场景 —— 学生无需懂参数，先看到结果
 *  name / hint 走 i18n（见 web/js/i18n.js 的 preset.* 词条） */
export const PRESETS = [
    {
        id: 'mandelbrot',
        nameKey: 'preset.mandelbrot.name',
        hintKey: 'preset.mandelbrot.hint',
        shader: 'mandelbrot_fractal.wgsl',
        fields: 'fractal',
        params: { mandelbrot: 1, center: [-0.6, 0], zoom: 1, steps: 80, re: 0, im: 0 },
    },
    {
        id: 'julia',
        nameKey: 'preset.julia.name',
        hintKey: 'preset.julia.hint',
        shader: 'mandelbrot_fractal.wgsl',
        fields: 'fractal',
        planeSpan: 1.8,
        params: { mandelbrot: 0, center: [0, 0], zoom: 1, steps: 80, re: -0.4, im: 0.6 },
    },
    {
        id: 'julia2',
        nameKey: 'preset.julia2.name',
        hintKey: 'preset.julia2.hint',
        shader: 'mandelbrot_fractal.wgsl',
        fields: 'fractal',
        planeSpan: 1.8,
        params: { mandelbrot: 0, center: [0, 0], zoom: 1, steps: 90, re: -0.123, im: 0.745 },
    },
    {
        id: 'julia3',
        nameKey: 'preset.julia3.name',
        hintKey: 'preset.julia3.hint',
        shader: 'mandelbrot_fractal.wgsl',
        fields: 'fractal',
        planeSpan: 1.8,
        params: { mandelbrot: 0, center: [0, 0], zoom: 1, steps: 90, re: 0.285, im: 0.01 },
    },
    {
        id: 'mandelbrot-zoom',
        nameKey: 'preset.zoom.name',
        hintKey: 'preset.zoom.hint',
        shader: 'mandelbrot_fractal.wgsl',
        fields: 'fractal',
        params: { mandelbrot: 1, center: [-0.743643887, 0.131825904], zoom: 0.02, steps: 120, re: 0, im: 0 },
    },
    {
        id: 'newton',
        nameKey: 'preset.newton.name',
        hintKey: 'preset.newton.hint',
        shader: 'newton_fractal.wgsl',
        fields: 'newton',
        planeSpan: 2.6,
        params: { center: [0, 0], zoom: 1, steps: 40 },
    },
];

export class FractalModule {
    constructor(gpu) {
        this.gpu = gpu;
        this.preset = PRESETS[0];
        this.params = { ...this.preset.params };
        this.entry = null;
        this.usesNewton = false;
        // 平面坐标的半幅：曼德博全景约 ±2.2，朱利亚 ±1.6
        this.planeSpan = 1.15;
    }

    get name() {
        return t('module.fractal');
    }

    /** 载入预设。 */
    async loadPreset(presetId) {
        const p = PRESETS.find((x) => x.id === presetId);
        if (!p) throw new Error(`未知预设：${presetId}`);
        this.preset = p;
        this.params = { ...p.params };
        this.usesNewton = p.fields === 'newton';
        // 每个预设可单独指定平面视野范围
        this.planeSpan = p.planeSpan ?? (p.fields === 'newton' ? 2.6 : 1.15);

        this.gpu.setMobjectFields(this.usesNewton ? NEWTON_FIELDS : FRACTAL_FIELDS);
        this.entry = await this.gpu.loadPipeline(p.shader, {
            dataLayout: POINT_LAYOUT,
            // 传 .decl（纯成员声明），由 shader-loader 的虚拟片段负责包成 struct
            uniformMembers: this.gpu.mobjectBlock.decl,
        });
        this.update();
    }

    /** 把参数写入 uniform 并重建顶点。 */
    update() {
        const p = this.params;
        const mob = this.gpu.mobject;
        if (!mob) return;

        // quad 恰好覆盖相机帧
        const cam = this.gpu.camera;
        const halfW = cam.frameWidth / 2;
        const halfH = cam.frameHeight / 2;

        // 着色器：plane_point = (point - offset) / scale_factor
        //   point 是场景单位（相机帧内，半宽 halfW）
        //   offset = -center * sf，使场景原点对应平面上的 center
        // 推导可见平面范围：plane 在 point=halfW 处应等于 center + planeSpan/zoom
        //   halfW / sf = planeSpan / zoom   =>   sf = halfW * zoom / planeSpan
        // zoom 越大 sf 越大 => 可见平面范围越小 => 放大（符合直觉）
        const sf = (halfW * p.zoom) / this.planeSpan;
        mob.setFloats('is_fixed_in_frame', 1);
        mob.setFloats('offset', [-p.center[0] * sf, -p.center[1] * sf, 0]);
        mob.setFloats('scale_factor', sf);
        mob.setFloats('opacity', 1);
        // 全零 shading 表示不做光照
        mob.setFloats('shading', [0, 0, 0]);
        mob.setFloats('n_steps', p.steps);
        if (this.usesNewton) {
            // 牛顿分形：写入多项式系数与根
            const cfg = NEWTON_CUBIC_MINUS_1;
            mob.setFloats('n_roots', cfg.nRoots);
            mob.setFloats('saturation_factor', 1.4);
            mob.setFloats('black_for_cycles', 0);
            mob.setFloats('is_parameter_space', 0);
            mob.setFloats('julia_highlight', 0);
            mob.setArray('coefs', cfg.coefs, 4);
            mob.setArray('roots', cfg.roots, 4);
        } else {
            mob.setFloats('mandelbrot', p.mandelbrot);
            mob.setFloats('parameter', [p.re, p.im]);
        }
        mob.setArray('colors', DEFAULT_COLORS, 4);
        mob.upload(this.gpu.device, this.gpu.mobjectBuffer);

        this.gpu.uploadRecords(makeQuadRecords(halfW, halfH));
    }

    /** 相机视角：分形平铺在平面上，正对即可。 */
    applyCamera() {
        this.gpu.camera.theta = 0;
        this.gpu.camera.phi = 0;
        this.gpu.camera.zoom = 1;
        this.gpu.camera.center = [0, 0, 0];
    }

    /**
     * 屏幕坐标 -> 平面坐标（用于以光标为锚点缩放）。
     * 与 update() 的映射严格对应：
     *   场景点 = NDC / frame_rescale_factors
     *   平面点 = (场景点 - offset) / sf，其中 offset = -center * sf
     *        => 平面点 = 场景点 / sf + center
     */
    screenToPlane(clientX, clientY, rect, zoom) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cam = this.gpu.camera;
        const u = (clientX - rect.left) * dpr;
        const v = (clientY - rect.top) * dpr;
        const ndcX = (u / this.gpu.width) * 2 - 1;
        const ndcY = 1 - (v / this.gpu.height) * 2;
        const sceneX = ndcX / (2 / cam.frameWidth);
        const sceneY = ndcY / (2 / cam.frameHeight);
        const sf = (cam.frameWidth / 2) * zoom / this.planeSpan;
        return [sceneX / sf + this.params.center[0], sceneY / sf + this.params.center[1]];
    }

    /**
     * 画布交互：平移 / 以光标为锚点缩放 / 复位。
     * 由 app 统一转发；**语义由模块自己决定**（3D 模块会改成轨道旋转）。
     * ctx: { gpu, invalidate(), syncPanel() }
     */
    handleCanvasEvent(e, ctx) {
        const p = this.params;
        const cam = ctx.gpu.camera;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        if (e.type === 'pan') {
            // 屏幕像素 -> 平面单位，sf 与 update() 中的公式一致
            const sf = (cam.frameWidth / 2) * p.zoom / this.planeSpan;
            const sx = e.dx * dpr / ctx.gpu.height * cam.frameHeight / sf;
            const sy = e.dy * dpr / ctx.gpu.height * cam.frameHeight / sf;
            p.center[0] -= sx;
            p.center[1] += sy;
            this.update();
        } else if (e.type === 'zoom') {
            // 以光标位置为锚点缩放
            const before = p.zoom;
            p.zoom = Math.min(3, Math.max(0.004, p.zoom * (1 + e.delta)));
            if (p.zoom !== before) {
                // 让光标下的平面点保持不动
                const r = ctx.canvas.getBoundingClientRect();
                const cx = e.cx ?? (r.left + r.width / 2);
                const cy = e.cy ?? (r.top + r.height / 2);
                const beforePt = this.screenToPlane(cx, cy, r, before);
                this.update();
                const afterPt = this.screenToPlane(cx, cy, r, p.zoom);
                p.center[0] += beforePt[0] - afterPt[0];
                p.center[1] += beforePt[1] - afterPt[1];
                this.update();
            }
        } else if (e.type === 'reset') {
            p.zoom = this.preset.params.zoom;
            p.center = [...this.preset.params.center];
            this.update();
        }
    }

    /** 播放按钮的一步：缓慢自动放大，演示自相似性 */
    playStep() {
        const p = this.params;
        p.zoom = Math.max(0.02, p.zoom * 0.995);
        this.update();
    }

    get draws() {
        return [{ entry: this.entry, vertexCount: 6 }];
    }

    /** 导出 PNG（用离屏读回，比抓 canvas 可靠）。 */
    async toPNG() {
        const { pixels, width, height } = await this.gpu.renderToPixels(this.draws);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
        return canvas.toDataURL('image/png');
    }
}

/**
 * 参数面板描述 —— 由 web/js/panel.js 通用渲染。
 *
 * 结构：
 *   { type: 'section', labelKey }
 *   { type: 'group',   visible?(params, inst), children: [...] }
 *   { type: 'slider',  key, labelKey, min, max, step, format?, round?, visible? }
 * 新增参数**只改这里**，不用动 app.js。
 */
const PANEL = [
    { type: 'section', labelKey: 'section.basic' },
    {
        type: 'slider', key: 'steps', labelKey: 'ctrl.steps',
        min: 8, max: 300, step: 1,
        round: Math.round, format: (v) => String(Math.round(v)),
    },
    {
        // 朱利亚参数：只在朱利亚模式（mandelbrot === 0）显示
        type: 'group',
        visible: (p) => p.mandelbrot === 0,
        children: [
            {
                type: 'slider', key: 're', labelKey: 'ctrl.re',
                min: -1.5, max: 1.5, step: 0.001, format: (v) => v.toFixed(3),
            },
            {
                type: 'slider', key: 'im', labelKey: 'ctrl.im',
                min: -1.5, max: 1.5, step: 0.001, format: (v) => v.toFixed(3),
            },
        ],
    },
    { type: 'section', labelKey: 'section.view' },
    {
        type: 'slider', key: 'zoom', labelKey: 'ctrl.zoom',
        min: 0.005, max: 3, step: 0.005,
        format: (v) => '1/' + Math.round(1 / v),
    },
];

/**
 * 模块描述符 —— 注册进 web/js/modules/registry.js 即可出现在侧栏。
 * 约定：presets / panel 是数据，create(gpu) 返回的实例负责渲染与交互。
 */
export const fractalModule = {
    id: 'fractal',
    nameKey: 'module.fractal',
    presets: PRESETS,
    panel: PANEL,
    create: (gpu) => new FractalModule(gpu),
};
