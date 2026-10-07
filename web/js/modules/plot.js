/**
 * 函数绘图器 —— 第二个模块
 *
 * 用上游 stroke.wgsl / fill.wgsl（零改写）画坐标轴、函数曲线、填充区域。
 *
 * ── 图层布局（见 gpu.js 的"图层"一节）──
 *   L_BACK   网格 / 刻度 / 坐标轴        （描边）
 *   L_FILL   被填充的区域                （填充三趟）
 *   L_FRONT  函数曲线 / 矩形轮廓 / 竖线  （描边）
 * 填充夹在中间，于是它压在网格之上、曲线之下。
 *
 * ── 填充是怎么画的 ──
 * 每个图层有自己的一块 mobject uniform，填充色是那块 uniform 上的一个值，
 * 所以**一层只能有一种填充色**（这正是上游"一个 mobject 一次填充"的语义）。
 * 填充的三趟见 pipeline.js 的注释：数绕数 → 描边框抗锯齿 → 上色并清模板。
 *
 * 坐标约定：is_fixed_in_frame = 1，几何直接画在「帧坐标」里
 * （x ∈ [-frameWidth/2, frameWidth/2]，y ∈ [-frameHeight/2, frameHeight/2]），
 * 数学坐标 ↔ 帧坐标的映射由 xSpan / ySpan / centerX / centerY 决定。
 */

import { t } from '../i18n.js';
import {
    VM_OBJECT_FIELDS, VM_STROKE_RECORD,
    VERTS_PER_STROKE_CURVE, VERTS_PER_FILL_CURVE,
    buildStrokeRecords, setVMObjectDefaults, setVMObjectFill, hasFill,
} from '../vmobject.js';
import { PipelineState } from '../pipeline.js';
import {
    toFrame, screenToMath, buildAxes, handlePanZoomReset,
} from '../axes.js';

const COLORS = {
    grid: [0.30, 0.33, 0.38, 1],
    axis: [0.82, 0.85, 0.89, 1],
    tick: [0.62, 0.66, 0.71, 1],
    curveA: [0.345, 0.769, 0.867, 1], // manim 蓝 #58C4DD
    curveB: [1.0, 0.80, 0.0, 1],      // manim 黄 #FFCC00
    rect: [0.514, 0.757, 0.404, 1],   // manim 绿 #83C167
    area: [0.345, 0.769, 0.867, 1],   // 定积分区域用蓝
    limit: [0.988, 0.384, 0.333, 1],  // manim 红 #FC6255
};

/** 图层编号 */
const L_BACK = 0;
const L_FILL = 1;
const L_FRONT = 2;
const LAYER_COUNT = 3;

/** stroke.wgsl 里那一行常量：填充边框把它翻成 true 再编译一遍（见 shader-loader.js） */
const BORDER_DECL = 'const IS_FILL_BORDER: bool = false;';

const CURVE_SAMPLES = 400;
const RIEMANN_INTERVAL = [0, 2];
const AREA_SAMPLES = 160;

/** 预设场景 */
export const PRESETS = [
    {
        id: 'trig',
        kind: 'trig',
        nameKey: 'preset.trig.name',
        hintKey: 'preset.trig.hint',
        params: {
            a: 1, b: 1, c: 0, n: 12, limit: 1.3, fillOpacity: 0.45,
            xSpan: 12, ySpan: 5, lineWidth: 3,
            centerX: 0, centerY: 0, keepAspect: false,
        },
    },
    {
        id: 'quadratic',
        kind: 'poly',
        nameKey: 'preset.quadratic.name',
        hintKey: 'preset.quadratic.hint',
        params: {
            a: 1, b: 0, c: 0, n: 12, limit: 1.3, fillOpacity: 0.45,
            xSpan: 10, ySpan: 10, lineWidth: 3,
            centerX: 0, centerY: 0, keepAspect: true,
        },
    },
    {
        id: 'riemann',
        kind: 'riemann',
        nameKey: 'preset.riemann.name',
        hintKey: 'preset.riemann.hint',
        params: {
            a: 1, b: 0, c: 0, n: 12, limit: 1.3, fillOpacity: 0.45,
            xSpan: 6, ySpan: 6, lineWidth: 3,
            centerX: 1, centerY: 1.2, keepAspect: true,
        },
    },
    {
        id: 'integral',
        kind: 'integral',
        nameKey: 'preset.integral.name',
        hintKey: 'preset.integral.hint',
        params: {
            a: 1, b: 0, c: 0, n: 12, limit: 1.3, fillOpacity: 0.45,
            xSpan: 5, ySpan: 5, lineWidth: 3,
            centerX: 1.5, centerY: 1.5, keepAspect: true,
        },
    },
];

export class PlotModule {
    constructor(gpu) {
        this.gpu = gpu;
        this.preset = PRESETS[0];
        this.params = { ...this.preset.params };
        this.entries = { line: null, fill: null, cover: null, border: null };
        this.passes = [];
    }

    get name() {
        return t('module.plot');
    }

    get lineEntry() { return this.entries.line; }
    get fillEntry() { return this.entries.fill; }
    get coverEntry() { return this.entries.cover; }
    get borderEntry() { return this.entries.border; }

    // ── 坐标系换算（实现见 axes.js，两套模块共用） ──

    /** 数学坐标 -> 帧坐标（z 恒为 0） */
    #toFrame(x, y) {
        return toFrame(this.gpu, this.params, x, y);
    }

    // ── 载入与更新 ────────────────────────────────

    async loadPreset(presetId) {
        const p = PRESETS.find((x) => x.id === presetId);
        if (!p) throw new Error(`未知预设：${presetId}`);
        this.preset = p;
        this.params = { ...p.params };

        // 三个图层：背景 / 填充 / 前景
        this.gpu.setMobjectFields(VM_OBJECT_FIELDS, LAYER_COUNT);
        const common = {
            dataLayout: VM_STROKE_RECORD,
            uniformMembers: this.gpu.mobjectBlock.decl,
        };
        this.entries.line = await this.gpu.loadPipeline('stroke.wgsl', common);
        this.entries.fill = await this.gpu.loadPipeline('fill.wgsl', {
            ...common, state: PipelineState.WINDING_COUNT,
        });
        this.entries.cover = await this.gpu.loadPipeline('fill.wgsl', {
            ...common, state: PipelineState.WINDING_COVER,
        });
        this.entries.border = await this.gpu.loadPipeline('stroke.wgsl', {
            ...common,
            state: PipelineState.FILL_BORDER,
            replace: { [BORDER_DECL]: BORDER_DECL.replace('false', 'true') },
        });
        this.update();
    }

    update() {
        const p = this.params;
        if (!this.gpu.layers.length || !this.entries.line) return;

        // 等比时让纵向范围跟随横向范围，避免图形被拉扁
        const cam = this.gpu.camera;
        if (p.keepAspect) p.ySpan = p.xSpan * (cam.frameHeight / cam.frameWidth);

        const fillRgba = this.#fillRgba();
        const back = this.#uploadLayer(L_BACK, this.#backdrop());
        const fill = this.#uploadLayer(L_FILL, this.#fillSubpaths(), fillRgba);
        const front = this.#uploadLayer(L_FRONT, this.#foreground());

        const passes = [];
        if (back > 0) {
            passes.push({
                entry: this.entries.line, layer: L_BACK,
                vertexCount: back * VERTS_PER_STROKE_CURVE,
            });
        }
        if (fill > 0 && hasFill(fillRgba)) {
            const fillVerts = fill * VERTS_PER_FILL_CURVE;
            // ① 只把绕数写进模板缓冲
            passes.push({ entry: this.entries.fill, layer: L_FILL, vertexCount: fillVerts });
            // ② 在形状之外画一圈填充色，给边缘抗锯齿；
            //    比路径多一段曲线：未闭合子路径的封闭弦没有"子路径末尾曲线"来代替它
            passes.push({
                entry: this.entries.border, layer: L_FILL,
                vertexCount: (fill + 1) * VERTS_PER_STROKE_CURVE,
            });
            // ③ 上色，并把模板清零
            passes.push({ entry: this.entries.cover, layer: L_FILL, vertexCount: fillVerts });
        }
        if (front > 0) {
            passes.push({
                entry: this.entries.line, layer: L_FRONT,
                vertexCount: front * VERTS_PER_STROKE_CURVE,
            });
        }
        this.passes = passes;
    }

    /**
     * 把一组子路径写进某一层，返回这层的曲线数。
     * @param {number} index 图层号
     * @param {Array} subpaths
     * @param {number[]|null} fillRgba 该层的填充色（null = 只描边）
     */
    #uploadLayer(index, subpaths, fillRgba = null) {
        const layer = this.gpu.layer(index);
        if (!layer) return 0;
        setVMObjectDefaults(layer.block);
        if (fillRgba) setVMObjectFill(layer.block, fillRgba);
        layer.block.upload(this.gpu.device, layer.buffer);

        const rec = buildStrokeRecords(subpaths);
        this.gpu.uploadRecords(rec.data, index);
        return rec.curveCount;
    }

    /** 填充色（整层共用；alpha 为 0 时整层跳过填充） */
    #fillRgba() {
        const o = Math.max(0, Math.min(1, this.params.fillOpacity ?? 0.45));
        const c = this.preset.kind === 'integral' ? COLORS.area : COLORS.rect;
        return [c[0], c[1], c[2], o];
    }

    // ── 几何 ──────────────────────────────────────

    /** L_BACK：网格 + 刻度 + 坐标轴（实现见 axes.js） */
    #backdrop() {
        return buildAxes(this.gpu, this.params, COLORS);
    }

    /** L_FRONT：曲线 + 矩形轮廓 + 上限竖线 */
    #foreground() {
        const p = this.params;
        const subs = [];
        for (const fn of this.#functions()) {
            subs.push(...this.#sampleCurve(fn.f, fn.color, p.lineWidth));
        }
        if (this.preset.kind === 'riemann') subs.push(...this.#riemannRects());
        if (this.preset.kind === 'integral') subs.push(this.#upperLimitLine());
        return subs;
    }

    /** L_FILL：要被填充的封闭子路径 */
    #fillSubpaths() {
        if (this.preset.kind === 'riemann') return this.#riemannRects();
        if (this.preset.kind === 'integral') return [this.#areaPolygon()];
        return [];
    }

    /** 当前预设要画的函数（可能不止一条） */
    #functions() {
        const p = this.params;
        switch (this.preset.kind) {
            case 'trig':
                return [
                    { f: (x) => p.a * Math.sin(p.b * x + p.c), color: COLORS.curveA },
                    { f: (x) => p.a * Math.cos(p.b * x + p.c), color: COLORS.curveB },
                ];
            case 'poly':
                return [{ f: (x) => p.a * x * x + p.b * x + p.c, color: COLORS.curveA }];
            case 'riemann':
            case 'integral':
                return [{ f: (x) => x * x, color: COLORS.curveA }];
            default:
                return [];
        }
    }

    /**
     * 采样一条函数曲线。跳出视野、出现无穷/NaN、或相邻两点跳变过大时断开，
     * 形成多条子路径 —— 这就是 tan() 这类函数不画出竖直渐近线的办法。
     */
    #sampleCurve(fn, color, width) {
        const p = this.params;
        const N = CURVE_SAMPLES;
        const x0 = p.centerX - p.xSpan / 2;
        const x1 = p.centerX + p.xSpan / 2;
        const yLimit = p.ySpan * 1.5;
        const subs = [];
        let cur = [];
        let prevY = null;

        for (let i = 0; i <= N; i++) {
            const x = x0 + ((x1 - x0) * i) / N;
            const y = fn(x);
            const bad = !Number.isFinite(y)
                || Math.abs(y) > yLimit
                || (prevY !== null && Math.abs(y - prevY) > p.ySpan);
            if (bad) {
                if (cur.length >= 2) subs.push({ anchors: cur, width, rgba: color });
                cur = [];
                prevY = null;
                continue;
            }
            cur.push([...this.#toFrame(x, y), 0]);
            prevY = y;
        }
        if (cur.length >= 2) subs.push({ anchors: cur, width, rgba: color });
        return subs;
    }

    /**
     * 黎曼和矩形。每个矩形是一条**闭合**子路径（首点重复一遍），
     * 所以既能被填充，也能自己绕一圈描边。
     */
    #riemannRects() {
        const p = this.params;
        const n = Math.max(1, Math.round(p.n));
        const [a, b] = RIEMANN_INTERVAL;
        const dx = (b - a) / n;
        const subs = [];
        for (let i = 0; i < n; i++) {
            const xm = a + (i + 0.5) * dx;
            const h = xm * xm;
            if (!Number.isFinite(h)) continue;
            const xl = a + i * dx;
            const xr = xl + dx;
            const anchors = [
                [...this.#toFrame(xl, 0), 0],
                [...this.#toFrame(xr, 0), 0],
                [...this.#toFrame(xr, h), 0],
                [...this.#toFrame(xl, h), 0],
                [...this.#toFrame(xl, 0), 0], // 闭合
            ];
            subs.push({ anchors, width: 1.5, rgba: COLORS.rect });
        }
        return subs;
    }

    /**
     * 定积分区域：y = x² 从 0 到 b、再沿 x 轴回到原点，一条闭合子路径。
     * 填充本身不需要闭合（fill.wgsl 一律扇回子路径起点），
     * 但描边需要，所以老老实实把首点再写一遍。
     */
    #areaPolygon() {
        const b = Math.max(0.05, this.params.limit);
        const anchors = [];
        for (let i = 0; i <= AREA_SAMPLES; i++) {
            const x = (b * i) / AREA_SAMPLES;
            anchors.push([...this.#toFrame(x, x * x), 0]);
        }
        anchors.push([...this.#toFrame(b, 0), 0]);   // 沿 x 轴回来
        anchors.push([...this.#toFrame(0, 0), 0]);   // 闭合（与首点重合）
        return { anchors, width: 1.5, rgba: COLORS.area };
    }

    /** 上限处的竖线，让"积到哪儿"看得见 */
    #upperLimitLine() {
        const b = Math.max(0.05, this.params.limit);
        return {
            anchors: [[...this.#toFrame(b, 0), 0], [...this.#toFrame(b, b * b), 0]],
            width: 2, rgba: COLORS.limit,
        };
    }

    // ── 相机与交互 ────────────────────────────────

    /** 相机复位：函数图画在帧坐标里，相机保持正对原点即可 */
    applyCamera() {
        this.gpu.camera.theta = 0;
        this.gpu.camera.phi = 0;
        this.gpu.camera.zoom = 1;
        this.gpu.camera.center = [0, 0, 0];
    }

    /** 屏幕坐标 -> 数学坐标 */
    screenToMath(clientX, clientY) {
        return screenToMath(this.gpu, this.params, clientX, clientY);
    }

    /**
     * 画布交互：拖拽平移视野中心，滚轮以光标为锚点缩放，双击复位视野。
     * 实现见 axes.js（与向量场模块共用）。
     */
    handleCanvasEvent(e, ctx) {
        handlePanZoomReset(this, e, ctx);
    }

    /** 播放按钮的一步：正弦滚相位，黎曼和逐渐加细，定积分上限来回扫 */
    playStep() {
        const p = this.params;
        if (this.preset.kind === 'trig') {
            p.c += 0.03;
            if (p.c > Math.PI) p.c -= 2 * Math.PI;
        } else if (this.preset.kind === 'riemann') {
            p.n = p.n >= 60 ? 1 : p.n + 0.2;
        } else if (this.preset.kind === 'integral') {
            p.limit += 0.012;
            if (p.limit > 1.7) p.limit = 0.2;
        }
        this.update();
    }

    get draws() {
        return this.passes;
    }

    /** 导出 PNG（离屏读回，比抓 canvas 可靠） */
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

/** 参数面板描述（由 web/js/panel.js 通用渲染） */
const kindIs = (...kinds) => (p, inst) => kinds.includes(inst?.preset?.kind);
const notKind = (...kinds) => (p, inst) => !kinds.includes(inst?.preset?.kind);

const PANEL = [
    { type: 'section', labelKey: 'section.basic' },
    {
        type: 'slider', key: 'a', labelKey: 'ctrl.coeffA',
        min: -3, max: 3, step: 0.01, format: (v) => v.toFixed(2),
        visible: notKind('riemann', 'integral'),
    },
    {
        type: 'slider', key: 'b', labelKey: 'ctrl.coeffB',
        min: -5, max: 5, step: 0.01, format: (v) => v.toFixed(2),
        visible: notKind('riemann', 'integral'),
    },
    {
        type: 'slider', key: 'c', labelKey: 'ctrl.coeffC',
        min: -5, max: 5, step: 0.01, format: (v) => v.toFixed(2),
        visible: notKind('riemann', 'integral'),
    },
    {
        type: 'slider', key: 'n', labelKey: 'ctrl.rectangles',
        min: 1, max: 100, step: 1,
        format: (v) => String(Math.round(v)),
        visible: kindIs('riemann'),
    },
    {
        type: 'slider', key: 'limit', labelKey: 'ctrl.upperLimit',
        min: 0.2, max: 1.8, step: 0.01, format: (v) => v.toFixed(2),
        visible: kindIs('integral'),
    },
    {
        type: 'slider', key: 'fillOpacity', labelKey: 'ctrl.fillOpacity',
        min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2),
        visible: notKind('trig', 'poly'),
    },
    { type: 'section', labelKey: 'section.view' },
    {
        type: 'slider', key: 'xSpan', labelKey: 'ctrl.xSpan',
        min: 1, max: 60, step: 0.5, format: (v) => v.toFixed(1),
    },
    {
        type: 'slider', key: 'ySpan', labelKey: 'ctrl.ySpan',
        min: 1, max: 60, step: 0.5, format: (v) => v.toFixed(1),
        visible: (p) => !p.keepAspect,
    },
    { type: 'check', key: 'keepAspect', labelKey: 'ctrl.keepAspect' },
    {
        type: 'slider', key: 'lineWidth', labelKey: 'ctrl.lineWidth',
        min: 1, max: 8, step: 0.5, format: (v) => v.toFixed(1),
    },
];

/** 模块描述符 —— 注册进 registry.js 即出现在侧栏 */
export const plotModule = {
    id: 'plot',
    nameKey: 'module.plot',
    presets: PRESETS,
    panel: PANEL,
    create: (gpu) => new PlotModule(gpu),
};
