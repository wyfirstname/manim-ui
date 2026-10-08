/**
 * 概率分布 —— 第八个模块
 *
 * 一句话：把"随机变量取什么值、有多大概率"画成图，并且让**曲线下的面积**
 * 和概率这两个概念在同一幅画里对上。
 *
 * ── 四个预设 ──
 *   正态分布 N(μ, σ²)      钟形曲线。屏幕上标出 [a, b] 区间，
 *                          黄色那块面积就是 P(a < X < b)。
 *                          默认 [−σ, σ]，也就是那个著名的 68%。
 *   二项分布 B(n, p)       n 次伯努利试验里成功 k 次的概率，画成柱状图。
 *                          绿色曲线是正态近似 N(np, √(np(1−p)))——n 一大就贴合。
 *   泊松分布 Pois(λ)       单位时间内稀有事件发生 k 次的概率。
 *                          λ 很大时同样逼近正态（近似曲线可开）。
 *   指数分布 Exp(λ)        第一次事件发生的等待时间。默认阴影是 [0, 1/λ]，
 *                          因为指数分布无记忆，这一段恰好是 1 − 1/e ≈ 63.2%。
 *
 * ── 画面上有六种东西 ──
 *   坐标网格 / 坐标轴        灰
 *   分布下方的面积           淡蓝（总面积 = 1）
 *   区间 [a, b] 的面积       黄 —— **这一块就是概率**
 *   曲线 / 柱轮廓            蓝（离散分布画成柱，柱宽 0.78）
 *   均值线                   红，竖在 E[X] 处
 *   概率条                   顶部一条定长的条，高亮部分按 P(a<X<b) 填 ——
 *                            分布拖来拖去时，这个"进度条"始终把数值大小说清楚
 *
 * ── 四个预设的 E[X] 与 Var[X] ──
 *   正态    μ, σ²
 *   二项    np, np(1−p)
 *   泊松    λ, λ
 *   指数    1/λ, 1/λ²
 * 这四行就是「均值线画在哪」「正态近似的参数是多少」的全部依据。
 *
 * ── 数值细节 ──
 *   · 二项与泊松的概率用**对数阶乘**算（Lanczos 近似 lgamma），
 *     否则 n = 40、k = 20 时中间量 40! 早就溢出了；
 *   · 连续分布的区间概率：指数分布有初等原函数，直接解析；正态没有，
 *     用复合 Simpson 并按 σ 自适应加密分段（每段 ≤ σ/200），
 *     算到 68.268949% 这种小数点后六位都对得上；
 *   · 离散分布直接对 k 求和 —— 不做任何近似。
 *
 * 与绘图器 / 傅里叶级数共用 axes.js 的坐标映射、坐标轴与平移缩放。
 */

import { t } from '../i18n.js';
import {
    VM_OBJECT_FIELDS, VM_STROKE_RECORD,
    VERTS_PER_STROKE_CURVE, VERTS_PER_FILL_CURVE,
    buildStrokeRecords, setVMObjectDefaults, setVMObjectFill, hasFill,
} from '../vmobject.js';
import { PipelineState } from '../pipeline.js';
import { toFrame, buildAxes, handlePanZoomReset } from '../axes.js';

const COLORS = {
    grid: [0.24, 0.27, 0.32, 1],
    axis: [0.62, 0.67, 0.74, 1],
    tick: [0.50, 0.55, 0.62, 1],
    area: [0.345, 0.769, 0.867, 0.20],    // 淡蓝：整条分布下方的面积
    hilite: [1.000, 0.800, 0.000, 0.42],  // 黄：区间面积 = 概率
    curve: [0.345, 0.769, 0.867, 1],      // 蓝：曲线
    edge: [0.20, 0.23, 0.28, 0.95],       // 柱轮廓
    mean: [0.988, 0.384, 0.333, 1],       // 红：均值线
    approx: [0.514, 0.757, 0.404, 0.90],  // 绿：正态近似曲线
    barTrack: [0.35, 0.38, 0.44, 1],      // 灰：概率条底色
    barFill: [1.000, 0.800, 0.000, 1],    // 黄：概率条高亮段
};

/** 图层编号 */
const L_BACK = 0;
const L_AREA = 1;
const L_HILITE = 2;
const L_FRONT = 3;
const LAYER_COUNT = 4;

/** stroke.wgsl 里那一行常量：填充边框把它翻成 true 再编译一遍（见 shader-loader.js） */
const BORDER_DECL = 'const IS_FILL_BORDER: bool = false;';

/** 连续曲线的采样点数 */
const CURVE_POINTS = 480;
/** 复合 Simpson 积分的分段数（偶数） */
const INTEGRAL_STEPS = 600;
/** 柱宽（数学单位，k 的中心两侧各占一半） */
const BAR_WIDTH = 0.78;
/** 概率条：相对视野的长度、相对峰值的高度、屏幕宽度（像素） */
const BAR_SPAN = 0.42;
const BAR_Y = 1.34;
const BAR_PX = 14;

const SQRT2PI = Math.sqrt(2 * Math.PI);

// ── 数值工具 ──────────────────────────────────────────────────

/** Lanczos 近似的 ln Γ(x)：算二项系数与泊松分母的对数，避免阶乘溢出 */
const LANCZOS = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
];

function lgamma(x) {
    if (x < 0.5) {
        // 反射公式：Γ(x)·Γ(1−x) = π / sin(πx)
        return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    }
    const z = x - 1;
    let a = 0.99999999999980993;
    const s = z + 7.5;
    for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i] / (z + i + 1);
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(s) - s + Math.log(a);
}

const logFactorial = (k) => lgamma(k + 1);

/** 标准正态密度 */
export function normalPdf(x, mu, sigma) {
    if (!(sigma > 0)) return 0;
    const z = (x - mu) / sigma;
    return Math.exp(-0.5 * z * z) / (sigma * SQRT2PI);
}

/** 二项概率质量 P(K = k)，n 次试验、成功概率 p */
export function binomialPmf(k, n, p) {
    if (!Number.isFinite(k) || k < 0 || k > n) return 0;
    if (p <= 0) return k === 0 ? 1 : 0;
    if (p >= 1) return k === n ? 1 : 0;
    const logC = logFactorial(n) - logFactorial(k) - logFactorial(n - k);
    return Math.exp(logC + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

/** 泊松概率质量 P(K = k) */
export function poissonPmf(k, lambda) {
    if (!Number.isFinite(k) || k < 0 || !(lambda > 0)) return 0;
    return Math.exp(-lambda + k * Math.log(lambda) - logFactorial(k));
}

/** 指数密度 f(x) = λ·e^(−λx)（x < 0 处取 0） */
export function exponentialPdf(x, rate) {
    if (x < 0 || !(rate > 0)) return 0;
    return rate * Math.exp(-rate * x);
}

/**
 * 复合 Simpson 积分。
 *
 * 注意它的精度是「离散误差」性质的：误差 ≈ (b−a)·h⁴·max|f⁗|/180，
 * 所以**固定段数在长区间上会不够**（600 段积 e^(−x) 到 40 只有 1e-6 量级）。
 * 模块里对连续分布因此按区间长度自适应分段（见 intervalProbability），
 * 指数分布更是直接用解析式。这个函数留给需要通用积分的场合。
 */
export function integrate(fn, a, b, steps = INTEGRAL_STEPS) {
    if (!(b > a)) return 0;
    const n = steps % 2 === 0 ? steps : steps + 1;
    const h = (b - a) / n;
    let s = fn(a) + fn(b);
    for (let i = 1; i < n; i++) s += fn(a + i * h) * (i % 2 ? 4 : 2);
    return (s * h) / 3;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

// ── 预设 ──────────────────────────────────────────────────────

const COMMON = {
    mu: 0, sigma: 1,
    trials: 20, prob: 0.5,
    lambda: 4,
    rate: 1,
    a: -1, b: 1,
    showApprox: true, showMean: true, showProbBar: true,
    xSpan: 8, ySpan: 0.6, centerX: 0, centerY: 0.3,
    keepAspect: false,
    lineWidth: 2.6,
};

export const PRESETS = [
    {
        id: 'normal',
        kind: 'normal',
        nameKey: 'preset.normal.name',
        hintKey: 'preset.normal.hint',
        params: { ...COMMON, mu: 0, sigma: 1, a: -1, b: 1, xSpan: 8, ySpan: 0.6, centerX: 0, centerY: 0.3 },
    },
    {
        id: 'binomial',
        kind: 'binomial',
        nameKey: 'preset.binomial.name',
        hintKey: 'preset.binomial.hint',
        params: { ...COMMON, trials: 20, prob: 0.5, a: 8, b: 12, xSpan: 23, ySpan: 0.28, centerX: 10, centerY: 0.14 },
    },
    {
        id: 'poisson',
        kind: 'poisson',
        nameKey: 'preset.poisson.name',
        hintKey: 'preset.poisson.hint',
        params: { ...COMMON, lambda: 4, a: 2, b: 6, xSpan: 16, ySpan: 0.3, centerX: 7, centerY: 0.15 },
    },
    {
        id: 'exponential',
        kind: 'exponential',
        nameKey: 'preset.exponential.name',
        hintKey: 'preset.exponential.hint',
        params: { ...COMMON, rate: 1, a: 0, b: 1, xSpan: 5, ySpan: 1.4, centerX: 2.4, centerY: 0.7 },
    },
];

export class DistModule {
    constructor(gpu) {
        this.gpu = gpu;
        this.preset = PRESETS[0];
        this.params = { ...this.preset.params };
        this.entries = { line: null, fill: null, cover: null, border: null };
        this.passes = [];
        /** 视野自适应用：上一次的"分布形状"键 */
        this._fitKey = null;
        /** 当前区间的概率（概率条要用，测试也直接读它） */
        this.probability = 0;
        /** 当前生效的区间（离散时已整化成整数端点） */
        this.interval = [-1, 1];

        this.minSpan = 0.4;
    }

    get name() {
        return t('module.dist');
    }

    get lineEntry() { return this.entries.line; }
    get fillEntry() { return this.entries.fill; }
    get coverEntry() { return this.entries.cover; }
    get borderEntry() { return this.entries.border; }

    get kind() { return this.preset.kind; }

    /** 离散分布（二项 / 泊松）画柱，连续分布画曲线 */
    get isDiscrete() { return this.kind === 'binomial' || this.kind === 'poisson'; }

    // ── 载入与更新 ────────────────────────────────

    async loadPreset(presetId) {
        const p = PRESETS.find((x) => x.id === presetId);
        if (!p) throw new Error(`未知预设：${presetId}`);
        this.preset = p;
        this.params = { ...p.params };
        this._fitKey = null;

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
        if (!this.gpu.layers.length || !this.entries.line) return;
        this.#fitView();
        this.#updateInterval();

        const areaRgba = COLORS.area;
        const hiliteRgba = this.probability > 0 ? COLORS.hilite : null;

        const back = this.#uploadLayer(L_BACK, this.#backdrop());
        const area = this.#uploadLayer(L_AREA, this.#areaSubpaths(), areaRgba);
        const hilite = hiliteRgba
            ? this.#uploadLayer(L_HILITE, this.#hiliteSubpaths(), hiliteRgba) : 0;
        const front = this.#uploadLayer(L_FRONT, this.#foreground());

        const passes = [];
        if (back > 0) {
            passes.push({
                entry: this.entries.line, layer: L_BACK,
                vertexCount: back * VERTS_PER_STROKE_CURVE,
            });
        }
        // 两层填充各自三趟；WINDING_COVER 会把模板清零，所以谁先谁后互不干扰
        for (const [layer, curves] of [[L_AREA, area], [L_HILITE, hilite]]) {
            if (curves <= 0) continue;
            const verts = curves * VERTS_PER_FILL_CURVE;
            passes.push({ entry: this.entries.fill, layer, vertexCount: verts });
            passes.push({
                entry: this.entries.border, layer,
                vertexCount: (curves + 1) * VERTS_PER_STROKE_CURVE,
            });
            passes.push({ entry: this.entries.cover, layer, vertexCount: verts });
        }
        if (front > 0) {
            passes.push({
                entry: this.entries.line, layer: L_FRONT,
                vertexCount: front * VERTS_PER_STROKE_CURVE,
            });
        }
        this.passes = passes;
    }

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

    // ── 分布本身 ──────────────────────────────────

    /** 密度 / 质量函数值（离散分布对非整数 k 也返回 0） */
    f(x) {
        const p = this.params;
        switch (this.kind) {
            case 'normal': return normalPdf(x, p.mu, p.sigma);
            case 'binomial': return Number.isInteger(x) ? binomialPmf(x, Math.round(p.trials), p.prob) : 0;
            case 'poisson': return Number.isInteger(x) ? poissonPmf(x, p.lambda) : 0;
            default: return exponentialPdf(x, p.rate);
        }
    }

    /** E[X] */
    mean() {
        const p = this.params;
        switch (this.kind) {
            case 'normal': return p.mu;
            case 'binomial': return p.trials * p.prob;
            case 'poisson': return p.lambda;
            default: return 1 / Math.max(1e-6, p.rate);
        }
    }

    /** 标准差 √Var[X] */
    sd() {
        const p = this.params;
        switch (this.kind) {
            case 'normal': return p.sigma;
            case 'binomial': return Math.sqrt(Math.max(0, p.trials * p.prob * (1 - p.prob)));
            case 'poisson': return Math.sqrt(p.lambda);
            default: return 1 / Math.max(1e-6, p.rate);
        }
    }

    /** 曲线的最高点（用来定纵向量程与概率条位置） */
    peak() {
        const p = this.params;
        switch (this.kind) {
            case 'normal': return normalPdf(p.mu, p.mu, p.sigma);
            case 'binomial': {
                const n = Math.round(p.trials);
                let best = 0;
                for (let k = 0; k <= n; k++) best = Math.max(best, binomialPmf(k, n, p.prob));
                return best;
            }
            case 'poisson': {
                let best = 0;
                const hi = Math.ceil(p.lambda + 6 * Math.sqrt(p.lambda) + 6);
                for (let k = 0; k <= hi; k++) best = Math.max(best, poissonPmf(k, p.lambda));
                return best;
            }
            default: return p.rate;
        }
    }

    /** 当前区间 [a, b]（离散时要整化到整数端点） */
    getInterval() {
        const p = this.params;
        let a = Math.min(p.a, p.b);
        let b = Math.max(p.a, p.b);
        if (this.isDiscrete) {
            a = Math.ceil(a - 1e-9);
            b = Math.floor(b + 1e-9);
        }
        return [a, b];
    }

    /** P(a < X < b)：离散求和、连续做积分 */
    intervalProbability() {
        const [a, b] = this.getInterval();
        if (this.isDiscrete) {
            let s = 0;
            for (let k = a; k <= b; k++) s += this.f(k);
            return clamp(s, 0, 1);
        }
        if (this.kind === 'exponential') {
            // 指数分布有初等原函数，直接用解析式 —— 比数值积分又快又准
            const lo = Math.max(0, a);
            if (!(b > lo)) return 0;
            const rate = this.params.rate;
            return clamp(Math.exp(-rate * lo) - Math.exp(-rate * b), 0, 1);
        }
        // 正态没有初等原函数，走 Simpson；分段数按 σ 自适应
        // （固定 600 段在窄区间上已经够用，但 [−4σ, 4σ] 这种宽区间会不够，
        //   于是让每段不超过 σ/200，误差始终在 1e-11 量级）
        const sigma = Math.max(1e-6, this.params.sigma);
        let steps = Math.ceil(Math.abs(b - a) / (sigma / 200));
        steps = clampInt(steps, 240, 4000);
        if (steps % 2) steps += 1;
        return clamp(integrate((x) => this.f(x), a, b, steps), 0, 1);
    }

    #updateInterval() {
        this.interval = this.getInterval();
        this.probability = this.intervalProbability();
    }

    /**
     * 视野自适应：只在「分布的形状」变化时重算（σ / n / p / λ / rate），
     * 拖 a、b、μ 这些"探针"不会动视野 —— 否则阴影一扫过视野就跟着跳。
     */
    #fitView() {
        const p = this.params;
        const cam = this.gpu.camera;
        const ratio = cam.frameHeight / cam.frameWidth;
        const key = [this.kind, p.sigma, Math.round(p.trials), p.prob, p.lambda, p.rate].join('|');

        if (this._fitKey !== key) {
            this._fitKey = key;
            let lo;
            let hi;
            switch (this.kind) {
                case 'normal':
                    // 横轴上看 ±4σ 就够（尾巴之外的面积 < 1e-4）
                    hi = Math.max(4, 4 * p.sigma);
                    lo = -hi;
                    break;
                case 'binomial':
                    lo = -1;
                    hi = Math.round(p.trials) + 1;
                    break;
                case 'poisson':
                    lo = -1;
                    hi = Math.max(8, p.lambda + 4 * Math.sqrt(p.lambda) + 2);
                    break;
                default:
                    // 指数分布：尾巴到 5/λ 只剩 0.7%
                    hi = Math.max(3, 5 / Math.max(1e-6, p.rate));
                    lo = -0.06 * hi;
                    break;
            }
            p.xSpan = hi - lo;
            p.centerX = (lo + hi) / 2;
            p.ySpan = this.peak() * 1.5;
            p.centerY = p.ySpan / 2;
        }
        if (p.keepAspect) p.ySpan = p.xSpan * ratio;
    }

    // ── 几何 ──────────────────────────────────────

    /** 视野的数学左右端 */
    #viewRange() {
        const p = this.params;
        return [p.centerX - p.xSpan / 2, p.centerX + p.xSpan / 2];
    }

    #backdrop() {
        return buildAxes(this.gpu, this.params, COLORS);
    }

    /** 一整根柱子：底边 → 右边 → 顶边 → 左边 → 回底（显式闭合） */
    #bar(k, h, rgba, width) {
        const p = this.params;
        const w = BAR_WIDTH / 2;
        return {
            anchors: [
                [...toFrame(this.gpu, p, k - w, 0), 0],
                [...toFrame(this.gpu, p, k + w, 0), 0],
                [...toFrame(this.gpu, p, k + w, h), 0],
                [...toFrame(this.gpu, p, k - w, h), 0],
                [...toFrame(this.gpu, p, k - w, 0), 0],
            ],
            width, rgba,
        };
    }

    /** 连续分布：曲线 + 底边闭合成的一块面积 */
    #areaPath(x0, x1, rgba) {
        const p = this.params;
        const n = Math.max(2, Math.min(CURVE_POINTS, Math.round(CURVE_POINTS * (x1 - x0) / Math.max(1e-9, p.xSpan))));
        const anchors = [];
        for (let i = 0; i <= n; i++) {
            const x = x0 + ((x1 - x0) * i) / n;
            anchors.push([...toFrame(this.gpu, p, x, Math.max(0, this.f(x))), 0]);
        }
        anchors.push([...toFrame(this.gpu, p, x1, 0), 0]);
        anchors.push([...toFrame(this.gpu, p, x0, 0), 0]);
        return { anchors, width: 1, rgba };
    }

    /** L_AREA：整条分布下方的面积（总面积 = 1） */
    #areaSubpaths() {
        const [lo, hi] = this.#viewRange();
        if (this.isDiscrete) {
            const subs = [];
            for (let k = Math.ceil(lo); k <= Math.floor(hi); k++) {
                const h = this.f(k);
                if (h > 0) subs.push(this.#bar(k, h, COLORS.area, 1));
            }
            return subs;
        }
        return [this.#areaPath(lo, hi, COLORS.area)];
    }

    /** L_HILITE：区间 [a, b] 的面积 —— 这块就是概率 */
    #hiliteSubpaths() {
        const [lo, hi] = this.#viewRange();
        const [a, b] = this.interval;
        if (this.isDiscrete) {
            const subs = [];
            for (let k = Math.max(Math.ceil(lo), a); k <= Math.min(Math.floor(hi), b); k++) {
                const h = this.f(k);
                if (h > 0) subs.push(this.#bar(k, h, COLORS.hilite, 1));
            }
            return subs;
        }
        const x0 = clamp(a, lo, hi);
        const x1 = clamp(b, lo, hi);
        if (!(x1 > x0)) return [];
        return [this.#areaPath(x0, x1, COLORS.hilite)];
    }

    /** L_FRONT：曲线（或柱轮廓）+ 均值线 + 概率条 */
    #foreground() {
        const p = this.params;
        const subs = [];

        if (this.isDiscrete) {
            const [lo, hi] = this.#viewRange();
            for (let k = Math.ceil(lo); k <= Math.floor(hi); k++) {
                const h = this.f(k);
                if (h > 0) subs.push(this.#bar(k, h, COLORS.edge, 1));
            }
            if (p.showApprox) {
                const c = this.#curveOf((x) => normalPdf(x, this.mean(), this.sd()), COLORS.approx, p.lineWidth * 0.9);
                if (c) subs.push(c);
            }
        } else {
            subs.push(this.#curveOf((x) => this.f(x), COLORS.curve, p.lineWidth));
        }

        if (p.showMean) subs.push(this.#meanLine());
        if (p.showProbBar) subs.push(...this.#probBar());
        return subs;
    }

    /** 一条曲线折线（连续函数在任何 x 上都有定义） */
    #curveOf(fn, rgba, width) {
        const [lo, hi] = this.#viewRange();
        const anchors = [];
        for (let i = 0; i <= CURVE_POINTS; i++) {
            const x = lo + ((hi - lo) * i) / CURVE_POINTS;
            const y = fn(x);
            if (!Number.isFinite(y)) return null;
            anchors.push([...toFrame(this.gpu, this.params, x, Math.max(0, y)), 0]);
        }
        return { anchors, width, rgba };
    }

    /** 均值线：竖在 E[X] 处，高度取曲线峰值的 1.18 倍 */
    #meanLine() {
        const p = this.params;
        const m = this.mean();
        return {
            anchors: [
                [...toFrame(this.gpu, p, m, 0), 0],
                [...toFrame(this.gpu, p, m, this.peak() * 1.18), 0],
            ],
            width: 2, rgba: COLORS.mean,
        };
    }

    /**
     * 概率条：顶部一条定长的条，高亮段长度正比于 P(a < X < b)。
     * 面积是"看得见"的概率，这条是用来把"多少"这件事量化出来的 ——
     * 毕竟画布上不写数字。
     */
    #probBar() {
        const p = this.params;
        const span = BAR_SPAN * p.xSpan;
        const x0 = p.centerX - span / 2;
        const y = this.peak() * BAR_Y;
        const subs = [{
            anchors: [
                [...toFrame(this.gpu, p, x0, y), 0],
                [...toFrame(this.gpu, p, x0 + span, y), 0],
            ],
            width: BAR_PX, rgba: COLORS.barTrack,
        }];
        const len = span * this.probability;
        if (len > 1e-6) {
            subs.push({
                anchors: [
                    [...toFrame(this.gpu, p, x0, y), 0],
                    [...toFrame(this.gpu, p, x0 + len, y), 0],
                ],
                width: BAR_PX, rgba: COLORS.barFill,
            });
        }
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

    /** 播放时 b 扫描的区间（a 每次回绕时一起拨回起点） */
    #scanRange() {
        const p = this.params;
        switch (this.kind) {
            case 'normal':
                return { min: p.mu - 3 * p.sigma, max: p.mu + 3 * p.sigma, step: 0.05 * p.sigma };
            case 'binomial':
                return { min: 0, max: Math.round(p.trials), step: 0.4 };
            case 'poisson':
                return { min: 0, max: Math.round(p.lambda + 3 * Math.sqrt(p.lambda)), step: 0.35 };
            default: {
                const hi = Math.max(1, 4 / Math.max(1e-6, p.rate));
                return { min: 0, max: hi, step: hi / 90 };
            }
        }
    }

    /**
     * 播放：让区间上限 b 从分布左端扫到右端。
     * 于是那团黄色阴影**从头长到把整条曲线盖满** —— 这就是累积概率，
     * 扫完一整轮再把 a 拨回起点重新开始。
     */
    playStep() {
        const p = this.params;
        const { min, max, step } = this.#scanRange();
        p.b = p.b + step;
        if (p.b > max) {
            p.b = min;
            p.a = min;
        }
        if (p.b < p.a) p.b = p.a;
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
const intFormat = (v) => String(Math.round(v));
const f2 = (v) => v.toFixed(2);

const PANEL = [
    { type: 'section', labelKey: 'section.dist' },

    // 正态
    {
        type: 'slider', key: 'mu', labelKey: 'ctrl.mu',
        min: -3, max: 3, step: 0.05, format: f2, visible: kindIs('normal'),
    },
    {
        type: 'slider', key: 'sigma', labelKey: 'ctrl.sigma',
        min: 0.2, max: 2, step: 0.05, format: f2, visible: kindIs('normal'),
    },

    // 二项
    {
        type: 'slider', key: 'trials', labelKey: 'ctrl.trials',
        min: 1, max: 40, step: 1, round: Math.round, format: intFormat, visible: kindIs('binomial'),
    },
    {
        type: 'slider', key: 'prob', labelKey: 'ctrl.prob',
        min: 0.05, max: 0.95, step: 0.01, format: f2, visible: kindIs('binomial'),
    },

    // 泊松
    {
        type: 'slider', key: 'lambda', labelKey: 'ctrl.lambda',
        min: 0.5, max: 15, step: 0.1, format: (v) => v.toFixed(1), visible: kindIs('poisson'),
    },

    // 指数
    {
        type: 'slider', key: 'rate', labelKey: 'ctrl.rate',
        min: 0.2, max: 3, step: 0.05, format: f2, visible: kindIs('exponential'),
    },

    { type: 'section', labelKey: 'section.interval' },
    {
        type: 'slider', key: 'a', labelKey: 'ctrl.intervalA',
        min: -6, max: 6, step: 0.05, format: f2, visible: kindIs('normal'),
    },
    {
        type: 'slider', key: 'b', labelKey: 'ctrl.intervalB',
        min: -6, max: 6, step: 0.05, format: f2, visible: kindIs('normal'),
    },
    {
        type: 'slider', key: 'a', labelKey: 'ctrl.intervalA',
        min: 0, max: 40, step: 1, round: Math.round, format: intFormat, visible: kindIs('binomial', 'poisson'),
    },
    {
        type: 'slider', key: 'b', labelKey: 'ctrl.intervalB',
        min: 0, max: 40, step: 1, round: Math.round, format: intFormat, visible: kindIs('binomial', 'poisson'),
    },
    {
        type: 'slider', key: 'a', labelKey: 'ctrl.intervalA',
        min: 0, max: 10, step: 0.05, format: f2, visible: kindIs('exponential'),
    },
    {
        type: 'slider', key: 'b', labelKey: 'ctrl.intervalB',
        min: 0, max: 10, step: 0.05, format: f2, visible: kindIs('exponential'),
    },

    { type: 'section', labelKey: 'section.display' },
    { type: 'check', key: 'showApprox', labelKey: 'ctrl.showApprox', visible: kindIs('binomial', 'poisson') },
    { type: 'check', key: 'showMean', labelKey: 'ctrl.showMean' },
    { type: 'check', key: 'showProbBar', labelKey: 'ctrl.showProbBar' },

    { type: 'section', labelKey: 'section.view' },
    {
        type: 'slider', key: 'xSpan', labelKey: 'ctrl.xSpan',
        min: 1, max: 60, step: 0.5, format: (v) => v.toFixed(1),
    },
    {
        type: 'slider', key: 'ySpan', labelKey: 'ctrl.ySpan',
        min: 0.05, max: 6, step: 0.05, format: f2,
        visible: (p) => !p.keepAspect,
    },
    { type: 'check', key: 'keepAspect', labelKey: 'ctrl.keepAspect' },
    {
        type: 'slider', key: 'lineWidth', labelKey: 'ctrl.lineWidth',
        min: 1, max: 6, step: 0.1, format: (v) => v.toFixed(1),
    },
];

/** 模块描述符 —— 注册进 registry.js 即出现在侧栏 */
export const distModule = {
    id: 'dist',
    nameKey: 'module.dist',
    presets: PRESETS,
    panel: PANEL,
    create: (gpu) => new DistModule(gpu),
};
