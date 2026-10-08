/**
 * 傅里叶级数 —— 第六个模块
 *
 * 一句话：把方波、锯齿波、三角波这类「有棱角」的周期函数，写成无穷多项
 * 正弦波之和，然后用有限的 N 项去逼近它。
 *
 * ── 三个预设各自的级数 ──
 *   方波    f(x) = 4/π · Σ_{k 奇数} sin(kx)/k
 *           只有奇次谐波，系数按 1/k 衰减 —— 所以收敛得慢，跳变处永远有
 *           一条过冲的小尖（吉布斯现象），N 再大也压不平，只能压窄。
 *   锯齿波  f(x) = 2/π · Σ_{k=1..∞} (−1)^{k+1} sin(kx)/k
 *           所有次数都有，同样 1/k 衰减，同样有吉布斯尖。
 *   三角波  f(x) = 8/π² · Σ_{k 奇数} (−1)^{(k−1)/2} sin(kx)/k²
 *           系数按 1/k² 衰减 —— 收敛快得多，而且**没有**过冲，
 *           因为三角波本身连续。把 N 从 1 拖到 5 就已经很像了。
 *
 * 这三条放在一起看，正好说明一件事：级数收敛的快慢不取决于"波多复杂"，
 * 而取决于**函数本身光不光滑** —— 有跳变就只能 1/k，折线就能 1/k²。
 *
 * ── 画什么 ──
 *   L_BACK    网格 / 坐标轴
 *   L_FRONT   目标波形（灰，虚线感靠细线）+ 各次谐波（半透明彩线，可选）
 *             + N 项部分和（亮蓝，主角）
 * 两层都是描边，共用 stroke.wgsl 一条管线。
 *
 * 与函数绘图器共用 axes.js 的坐标映射、坐标轴与平移缩放。
 */

import { t } from '../i18n.js';
import {
    VM_OBJECT_FIELDS, VM_STROKE_RECORD,
    VERTS_PER_STROKE_CURVE,
    buildStrokeRecords, setVMObjectDefaults,
} from '../vmobject.js';
import { toFrame, buildAxes, handlePanZoomReset } from '../axes.js';

const COLORS = {
    grid: [0.24, 0.27, 0.32, 1],
    axis: [0.62, 0.67, 0.74, 1],
    tick: [0.50, 0.55, 0.62, 1],
    target: [0.52, 0.56, 0.63, 1],       // 灰：目标波形
    partial: [0.345, 0.769, 0.867, 1],   // 蓝：N 项部分和
};

/** 各次谐波用的颜色（画"成分分解"时用，都是半透明细线） */
const HARMONIC_COLORS = [
    [1.000, 0.800, 0.000, 0.45],   // 黄
    [0.514, 0.757, 0.404, 0.45],   // 绿
    [0.988, 0.384, 0.333, 0.40],   // 红
    [0.694, 0.537, 0.776, 0.45],   // 紫
    [1.000, 0.525, 0.184, 0.45],   // 橙
    [0.361, 0.816, 0.702, 0.45],   // 青绿
];

/** 图层编号 */
const L_BACK = 0;
const L_FRONT = 1;
const LAYER_COUNT = 2;

/** 一条曲线采多少点：方波边缘要锐，采样得够密 */
const SAMPLES = 900;
/** 谐波项数上限（也是播放时的回绕点） */
const MAX_TERMS = 40;
/** 画"成分分解"时最多画几根谐波，多了就是一团糊 */
const MAX_HARMONIC_LINES = 8;

const COMMON = {
    terms: 1,
    amplitude: 1,
    xSpan: 12.6, ySpan: 3,
    centerX: 0, centerY: 0, keepAspect: false,
    lineWidth: 2.5,
    showTarget: true, showHarmonics: false,
};

/** 预设场景 */
export const PRESETS = [
    {
        id: 'square',
        kind: 'square',
        nameKey: 'preset.square.name',
        hintKey: 'preset.square.hint',
        params: { ...COMMON, terms: 1 },
    },
    {
        id: 'sawtooth',
        kind: 'sawtooth',
        nameKey: 'preset.sawtooth.name',
        hintKey: 'preset.sawtooth.hint',
        params: { ...COMMON, terms: 3 },
    },
    {
        id: 'triangle',
        kind: 'triangle',
        nameKey: 'preset.triangle.name',
        hintKey: 'preset.triangle.hint',
        params: { ...COMMON, terms: 4 },
    },
];

export class FourierModule {
    constructor(gpu) {
        this.gpu = gpu;
        this.preset = PRESETS[0];
        this.params = { ...this.preset.params };
        this.entries = { line: null };
        this.passes = [];
        /** 谐波系数表的缓存（term 数与预设没变就不重算） */
        this._termKey = '';
        this._terms = [];
    }

    get name() {
        return t('module.fourier');
    }

    get lineEntry() { return this.entries.line; }

    // ── 载入与更新 ────────────────────────────────

    async loadPreset(presetId) {
        const p = PRESETS.find((x) => x.id === presetId);
        if (!p) throw new Error(`未知预设：${presetId}`);
        this.preset = p;
        this.params = { ...p.params };
        this._termKey = '';

        this.gpu.setMobjectFields(VM_OBJECT_FIELDS, LAYER_COUNT);
        this.entries.line = await this.gpu.loadPipeline('stroke.wgsl', {
            dataLayout: VM_STROKE_RECORD,
            uniformMembers: this.gpu.mobjectBlock.decl,
        });
        this.update();
    }

    update() {
        const p = this.params;
        if (!this.gpu.layers.length || !this.entries.line) return;

        const cam = this.gpu.camera;
        if (p.keepAspect) p.ySpan = p.xSpan * (cam.frameHeight / cam.frameWidth);

        const back = this.#uploadLayer(L_BACK, buildAxes(this.gpu, p, COLORS));
        const front = this.#uploadLayer(L_FRONT, this.#curves());

        const passes = [];
        if (back > 0) {
            passes.push({
                entry: this.entries.line, layer: L_BACK,
                vertexCount: back * VERTS_PER_STROKE_CURVE,
            });
        }
        if (front > 0) {
            passes.push({
                entry: this.entries.line, layer: L_FRONT,
                vertexCount: front * VERTS_PER_STROKE_CURVE,
            });
        }
        this.passes = passes;
    }

    #uploadLayer(index, subpaths) {
        const layer = this.gpu.layer(index);
        if (!layer) return 0;
        setVMObjectDefaults(layer.block);
        layer.block.upload(this.gpu.device, layer.buffer);

        const rec = buildStrokeRecords(subpaths);
        this.gpu.uploadRecords(rec.data, index);
        return rec.curveCount;
    }

    // ── 级数 ──────────────────────────────────────

    /**
     * 当前预设的前 N 项谐波系数表。
     *
     * 统一表成 [次数 k, 幅度 a]，部分和就是 Σ a·sin(kx)。
     * 「奇次谐波」在三个预设里都以 k = 2i+1 的形式出现，只有锯齿波是全次数。
     */
    #termsTable() {
        const n = Math.max(1, Math.min(MAX_TERMS, Math.round(this.params.terms)));
        const key = `${this.preset.kind}|${n}`;
        if (key === this._termKey) return this._terms;

        const list = [];
        if (this.preset.kind === 'sawtooth') {
            // 全次数，系数 2/(πk)，符号交替
            for (let i = 0; i < n; i++) {
                const k = i + 1;
                list.push([k, (2 / (Math.PI * k)) * (i % 2 === 0 ? 1 : -1)]);
            }
        } else if (this.preset.kind === 'triangle') {
            // 奇次数，系数 8/(π²k²)，符号按 (k−1)/2 交替
            for (let i = 0; i < n; i++) {
                const k = 2 * i + 1;
                const sign = ((k - 1) / 2) % 2 === 0 ? 1 : -1;
                list.push([k, (8 / (Math.PI * Math.PI * k * k)) * sign]);
            }
        } else {
            // 方波：奇次数，系数 4/(πk)
            for (let i = 0; i < n; i++) {
                const k = 2 * i + 1;
                list.push([k, 4 / (Math.PI * k)]);
            }
        }

        this._termKey = key;
        this._terms = list;
        return list;
    }

    /**
     * 目标波形本身（不截断的那个函数）。
     *
     * 注意三者必须和各自的级数**收敛到同一个函数**，否则画面上"灰线"和
     * "蓝线"会是两条不同的曲线（首版三角波就写成了相位偏 90° 的版本，
     * 测试里逐点比对才发现）。
     *
     * 三角波（级数 8/π² Σ (−1)^{(k−1)/2} sin(kx)/k²）收敛到的是
     * 「在 ±π 与 0 处为零、在 ±π/2 处取 ±1」的那条折线，
     * 也就是 (2/π)·arcsin(sin x)，而不是常见的 1 − 2|x|/π。
     */
    #target(x) {
        const TAU = 2 * Math.PI;
        // 把 x 折进 (-π, π]，再按波形算值
        let u = ((x % TAU) + TAU) % TAU;
        if (u > Math.PI) u -= TAU;
        switch (this.preset.kind) {
            case 'square':
                return u >= 0 ? 1 : -1;
            case 'sawtooth':
                return u / Math.PI;
            case 'triangle': {
                const a = Math.abs(u);
                const mag = a <= Math.PI / 2 ? (2 / Math.PI) * a : 2 - (2 / Math.PI) * a;
                return u >= 0 ? mag : -mag;
            }
            default:
                return 0;
        }
    }

    /** N 项部分和 */
    #partial(x, terms) {
        let s = 0;
        for (let i = 0; i < terms.length; i++) s += terms[i][1] * Math.sin(terms[i][0] * x);
        return s;
    }

    // ── 几何 ──────────────────────────────────────

    #curves() {
        const p = this.params;
        const terms = this.#termsTable();
        const amp = p.amplitude;
        const subs = [];

        // 目标波形：跳变处要断开，否则会画出一条竖直的"连接线"（数学上并不存在）
        if (p.showTarget) {
            subs.push(...this.#sample(
                (x) => amp * this.#target(x), COLORS.target, p.lineWidth * 1.2,
                1.2 * amp,
            ));
        }

        // 各次谐波成分：半透明细线，一眼看出"这份是哪些正弦拼出来的"
        if (p.showHarmonics) {
            const shown = Math.min(terms.length, MAX_HARMONIC_LINES);
            for (let i = 0; i < shown; i++) {
                const [k, a] = terms[i];
                subs.push(...this.#sample(
                    (x) => amp * a * Math.sin(k * x),
                    HARMONIC_COLORS[i % HARMONIC_COLORS.length],
                    Math.max(1, p.lineWidth * 0.55),
                ));
            }
        }

        subs.push(...this.#sample(
            (x) => amp * this.#partial(x, terms), COLORS.partial, p.lineWidth,
        ));
        return subs;
    }

    /**
     * 采样一条曲线。
     * @param {number} [jumpLimit] 相邻两点 y 差超过它就断开（用来切掉跳变处的竖直连线）
     */
    #sample(fn, color, width, jumpLimit = 0) {
        const p = this.params;
        const x0 = p.centerX - p.xSpan / 2;
        const x1 = p.centerX + p.xSpan / 2;
        const yLimit = p.ySpan * 1.5;
        const limit = jumpLimit > 0 ? jumpLimit : p.ySpan;

        const subs = [];
        let cur = [];
        let prevY = null;
        for (let i = 0; i <= SAMPLES; i++) {
            const x = x0 + ((x1 - x0) * i) / SAMPLES;
            const y = fn(x);
            const bad = !Number.isFinite(y)
                || Math.abs(y) > yLimit
                || (prevY !== null && Math.abs(y - prevY) > limit);
            if (bad) {
                if (cur.length >= 2) subs.push({ anchors: cur, width, rgba: color });
                cur = [];
                prevY = null;
                continue;
            }
            cur.push([...toFrame(this.gpu, p, x, y), 0]);
            prevY = y;
        }
        if (cur.length >= 2) subs.push({ anchors: cur, width, rgba: color });
        return subs;
    }

    // ── 相机与交互 ────────────────────────────────

    applyCamera() {
        this.gpu.camera.theta = 0;
        this.gpu.camera.phi = 0;
        this.gpu.camera.zoom = 1;
        this.gpu.camera.center = [0, 0, 0];
    }

    handleCanvasEvent(e, ctx) {
        handlePanZoomReset(this, e, ctx);
    }

    /** 播放：一项一项把谐波加进来，看波形怎么长成目标 */
    playStep() {
        const p = this.params;
        p.terms += 1 / 3;
        if (p.terms > MAX_TERMS) p.terms = 1;
        this.update();
    }

    get draws() {
        return this.passes;
    }

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
const PANEL = [
    { type: 'section', labelKey: 'section.basic' },
    {
        type: 'slider', key: 'terms', labelKey: 'ctrl.terms',
        min: 1, max: MAX_TERMS, step: 1,
        format: (v) => String(Math.round(v)),
    },
    {
        type: 'slider', key: 'amplitude', labelKey: 'ctrl.amplitude',
        min: 0.2, max: 2, step: 0.05, format: (v) => v.toFixed(2),
    },
    { type: 'section', labelKey: 'section.display' },
    { type: 'check', key: 'showTarget', labelKey: 'ctrl.showTarget' },
    { type: 'check', key: 'showHarmonics', labelKey: 'ctrl.showHarmonics' },
    { type: 'section', labelKey: 'section.view' },
    {
        type: 'slider', key: 'xSpan', labelKey: 'ctrl.xSpan',
        min: 2, max: 40, step: 0.5, format: (v) => v.toFixed(1),
    },
    {
        type: 'slider', key: 'ySpan', labelKey: 'ctrl.ySpan',
        min: 1, max: 30, step: 0.5, format: (v) => v.toFixed(1),
        visible: (p) => !p.keepAspect,
    },
    { type: 'check', key: 'keepAspect', labelKey: 'ctrl.keepAspect' },
    {
        type: 'slider', key: 'lineWidth', labelKey: 'ctrl.lineWidth',
        min: 1, max: 6, step: 0.5, format: (v) => v.toFixed(1),
    },
];

/** 模块描述符 —— 注册进 registry.js 即出现在侧栏 */
export const fourierModule = {
    id: 'fourier',
    nameKey: 'module.fourier',
    presets: PRESETS,
    panel: PANEL,
    create: (gpu) => new FourierModule(gpu),
};
