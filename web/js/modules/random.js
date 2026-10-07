/**
 * 随机过程 —— 第五个模块
 *
 * 三个预设演示概率论里最经典的三件事：
 *   大数定律      样本均值随试验次数收敛到期望
 *   中心极限定理  独立同分布变量之和标准化后收敛到正态分布
 *   随机游走      每步随机选方向，n 步后离原点的典型距离 ≈ √n · 步长
 *
 * ── 随机数：自己带一个，不用 Math.random ──
 * 用 mulberry32（32 位状态、一遍给出 [0,1)）。原因有三：
 *   1. 同一颗种子永远给出同一张图 —— 拖别的滑块（线宽、视野）不会让图形变样；
 *   2. 每个预设、每条曲线、每个游走个体用「种子 + 各自的盐」派生独立流，
 *      互不干扰；
 *   3. 前缀性质见下。
 *
 * ── 嵌套（前缀）结构：播放动画的关键 ──
 * 「样本均值」与「随机游走」天然是前缀：前 k 步的结果只依赖前 k 个随机数。
 * 于是播放时只要逐帧增大「已揭示的长度」，图形就是**连续生长**的，
 * 而不是每帧重新抽一批样本（那样会看到整幅图乱跳）。
 * 中心极限定理没有这个天然性质（Z_n 用到的量随 n 变），所以显式缓存一张
 * M × 24 的均匀数矩阵：不管 n 取几，用的都是同一批数的前 n 列，
 * 于是「n 从 1 加到 24」看起来是同一个分布在连续变形，而不是换了批数据。
 *
 * ── 图层（与函数绘图器同一套约定）──
 *   L_BACK    网格 / 坐标轴 / 典型距离圆     （描边）
 *   L_FILL    置信带（大数） / 直方图柱（中心极限）  （填充三趟）
 *   L_FRONT   样本均值曲线 / 正态曲线 / 游走路径      （描边）
 *
 * ── 三个预设各自在画什么 ──
 *   大数定律    x = 试验次数 n（线性），y = 前 n 次的经验均值。
 *              每颗种子一条曲线（runs 条），叠加 ±σ/√n 的收敛带（σ 由 p 定），
 *              黄线是真正的期望 p。曲线最后都会钻进带内并贴住黄线。
 *   中心极限定理  M 组「n 个均匀(0,1)之和」，标准化成 Z = (ΣXᵢ − n/2)/√(n/12)，
 *              画成密度直方图，叠加标准正态密度 φ(z)。n 越大越贴合。
 *   随机游走    每步在单位圆上随机取一个方向走固定步长，n 步后位置画成折线。
 *              灰圈半径 = √n·步长，是「典型距离」—— 大多数个体都在圈附近，
 *              远比最远距离 n·步长小得多，这正是 √n 标度的直观含义。
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
    band: [0.514, 0.757, 0.404, 0.18],  // 绿，半透明
    mean: [1.00, 0.80, 0.00, 1],        // 黄：真值线
    bars: [0.345, 0.769, 0.867, 0.85],  // 蓝：直方图
    barEdge: [0.16, 0.18, 0.22, 0.85],
    normal: [1.00, 0.80, 0.00, 1],      // 黄：标准正态密度
    circle: [0.62, 0.67, 0.74, 0.5],    // 灰：典型距离圆
};

/** runs 条曲线用的颜色（manim 调色板） */
const RUN_COLORS = [
    [0.345, 0.769, 0.867, 1],   // blue   #58C4DD
    [0.988, 0.384, 0.333, 1],   // red    #FC6255
    [0.514, 0.757, 0.404, 1],   // green  #83C167
    [0.694, 0.537, 0.776, 1],   // purple #B189C6
    [0.361, 0.816, 0.702, 1],   // teal   #5CD0B3
    [1.000, 0.525, 0.184, 1],   // orange #FF862F
];

/** 图层编号 */
const L_BACK = 0;
const L_FILL = 1;
const L_FRONT = 2;
const LAYER_COUNT = 3;

/** 中心极限定理一次最多叠多少个均匀变量（也是缓存矩阵的列数） */
const MAX_N = 24;
/** 标准化的直方图固定画在 [-4, 4] 上（4σ 之外的概率 < 1e-4） */
const HIST_RANGE = [-4, 4];
/** 曲线锚点总预算：每段曲线着色器都要展开成 186 个顶点，锚点数直接决定顶点量 */
const CURVE_BUDGET = 1400;
const MAX_CURVE_POINTS = 900;
const BAND_POINTS = 160;
const NORMAL_POINTS = 220;
/** 随机游走每条路径最多画这么多点（超出就隔着取，见 #walkPaths 的注释） */
const WALK_MAX_POINTS = 700;
/** 典型距离圆的分段数 */
const CIRCLE_SEGMENTS = 128;

/** stroke.wgsl 里那一行常量：填充边框把它翻成 true 再编译一遍（见 shader-loader.js） */
const BORDER_DECL = 'const IS_FILL_BORDER: bool = false;';

// ── 随机数 ────────────────────────────────────────────────────

/** mulberry32：32 位状态的伪随机数生成器，返回 () => [0, 1) */
function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** 把「种子 + 盐」混成一个 32 位整数：不同盐得到互不相关的独立随机流 */
function mixSeed(seed, salt = 0) {
    return ((Math.round(seed) * 2654435761) ^ (salt * 40503)) >>> 0;
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

// ── 预设 ──────────────────────────────────────────────────────

/** 所有预设共享的参数键（面板按 kind 决定显隐，但键一律存在，免得读不到） */
const COMMON = {
    seed: 7,
    samples: 600,
    prob: 0.5,
    runs: 3,
    showBand: true,
    variables: 3,
    bins: 30,
    walkers: 6,
    walkSteps: 600,
    stepLength: 1,
    showCircle: true,
    xSpan: 600, ySpan: 1.15,
    centerX: 300, centerY: 0.5,
    keepAspect: false,
    lineWidth: 2.5,
};

export const PRESETS = [
    {
        id: 'lln',
        kind: 'lln',
        nameKey: 'preset.lln.name',
        hintKey: 'preset.lln.hint',
        params: {
            ...COMMON,
            prob: 0.5, samples: 600, runs: 3,
            xSpan: 600, ySpan: 1.15, centerX: 300, centerY: 0.5,
        },
    },
    {
        id: 'clt',
        kind: 'clt',
        nameKey: 'preset.clt.name',
        hintKey: 'preset.clt.hint',
        params: {
            ...COMMON,
            samples: 4000, variables: 3, bins: 30,
            xSpan: 8, ySpan: 0.9, centerX: 0, centerY: 0.35,
            lineWidth: 3,
        },
    },
    {
        id: 'walk',
        kind: 'walk',
        nameKey: 'preset.walk.name',
        hintKey: 'preset.walk.hint',
        params: {
            ...COMMON,
            seed: 12,               // 这颗种子下 6 个个体恰好散在 √n 圆附近（观感最好）
            walkers: 6, walkSteps: 600, stepLength: 1,
            xSpan: 94, centerX: 0, centerY: 0,
            keepAspect: true, lineWidth: 1.6,
        },
    },
];

export class RandomModule {
    constructor(gpu) {
        this.gpu = gpu;
        this.preset = PRESETS[0];
        this.params = { ...this.preset.params };
        this.entries = { line: null, fill: null, cover: null, border: null };
        this.passes = [];

        // 播放用：已揭示的比例（大数定律 / 随机游走）
        this.grow = 1;
        // 播放用：中心极限定理的节拍器（每 5 帧加一个变量）
        this._tick = 0;
        // 视野自适应用：上一次「按数据定视野」时的数据形状
        this._fitKey = null;
        // 均匀数矩阵缓存（seed + 样本数决定）
        this._uniformKey = '';
        this._uniform = null;

        // 缩放下限：可以放得比函数绘图器更近
        this.minSpan = 1;
    }

    get name() {
        return t('module.random');
    }

    get lineEntry() { return this.entries.line; }
    get fillEntry() { return this.entries.fill; }
    get coverEntry() { return this.entries.cover; }
    get borderEntry() { return this.entries.border; }

    // ── 载入与更新 ────────────────────────────────

    async loadPreset(presetId) {
        const p = PRESETS.find((x) => x.id === presetId);
        if (!p) throw new Error(`未知预设：${presetId}`);
        this.preset = p;
        this.params = { ...p.params };
        this.grow = 1;
        this._tick = 0;
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
            passes.push({ entry: this.entries.fill, layer: L_FILL, vertexCount: fillVerts });
            // 边框那一趟比路径多一段曲线（未闭合子路径的封闭弦没有"末尾曲线"代替）
            passes.push({
                entry: this.entries.border, layer: L_FILL,
                vertexCount: (fill + 1) * VERTS_PER_STROKE_CURVE,
            });
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

    /** 把一组子路径写进某一层，返回这层的曲线数 */
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

    /**
     * 视野自适应：数据一换（样本数 / 步数），就把视野调到刚好装下。
     *
     * 只在「数据的形状」变化时动手，其余时候不碰 —— 这样滚轮缩放与拖拽平移
     * 不会被每帧的自适应顶回去（拖动滑块看细节才是有意义的操作）。
     * 键里带上 kind，切预设时必定重算一次。
     */
    #fitView() {
        const p = this.params;
        const cam = this.gpu.camera;
        const ratio = cam.frameHeight / cam.frameWidth;
        const key = `${this.preset.kind}:${Math.round(p.samples)}:${Math.round(p.walkSteps)}:${p.stepLength}`;

        if (this._fitKey !== key) {
            this._fitKey = key;
            if (this.preset.kind === 'lln') {
                p.xSpan = Math.max(20, Math.round(p.samples));
                p.centerX = p.xSpan / 2;
                p.centerY = 0.5;
                p.ySpan = 1.15;      // 样本均值恒在 [0, 1] 内
            } else if (this.preset.kind === 'walk') {
                // 典型半径 R = √n·步长；纵向留 2.4R（= ±1.2R），横向按画布宽高比铺开
                const R = Math.max(1e-6, p.stepLength) * Math.sqrt(Math.max(1, p.walkSteps));
                p.xSpan = Math.min(400, Math.max(10, 3.84 * R));
                p.centerX = 0;
                p.centerY = 0;
                p.ySpan = p.xSpan * ratio;
            }
        }
        if (p.keepAspect) p.ySpan = p.xSpan * ratio;
    }

    /** 填充色（整层共用）—— 大数定律是半透明置信带，中心极限定理是直方图柱 */
    #fillRgba() {
        switch (this.preset.kind) {
            case 'lln': return this.params.showBand ? COLORS.band : null;
            case 'clt': return COLORS.bars;
            default: return null;
        }
    }

    // ── 几何：三层各自画什么 ──────────────────────

    /** L_BACK：坐标轴网格；随机游走再加一个典型距离圆 */
    #backdrop() {
        const subs = buildAxes(this.gpu, this.params, COLORS);
        if (this.preset.kind === 'walk' && this.params.showCircle) {
            subs.push(this.#typicalCircle());
        }
        return subs;
    }

    /** L_FILL：大数定律的收敛带 / 中心极限定理的直方图柱 */
    #fillSubpaths() {
        if (this.preset.kind === 'lln') return this.#llnBand();
        if (this.preset.kind === 'clt') return this.#cltBars();
        return [];
    }

    /** L_FRONT：样本均值曲线 / 正态曲线 + 柱轮廓 / 游走路径 */
    #foreground() {
        if (this.preset.kind === 'lln') {
            return [...this.#llnCurves(), ...this.#llnMeanLine()];
        }
        if (this.preset.kind === 'clt') {
            return [...this.#cltBarOutlines(), ...this.#normalCurve()];
        }
        return this.#walkPaths();
    }

    // ── 大数定律 ──────────────────────────────────

    /** 前 n 次试验的经验均值序列（取前 reveal 个样本，前缀性质保证图形连续生长） */
    #llnCurves() {
        const p = this.params;
        const N = Math.max(2, Math.round(p.samples));
        const runs = clampInt(p.runs, 1, RUN_COLORS.length);
        const reveal = Math.max(2, Math.ceil(N * this.grow));
        const perRun = clampInt(Math.floor(CURVE_BUDGET / runs), 2, MAX_CURVE_POINTS);

        const subs = [];
        for (let run = 0; run < runs; run++) {
            const rng = prng(mixSeed(p.seed, run * 7919 + 1));
            // 前缀和：sum[k] = 前 k 个样本之和，于是第 n 次的经验均值就是 sum[n] / n
            const sum = new Float64Array(N + 1);
            for (let i = 1; i <= N; i++) {
                sum[i] = sum[i - 1] + (rng() < p.prob ? 1 : 0);
            }
            const J = Math.min(perRun, reveal);
            const anchors = [];
            for (let j = 0; j < J; j++) {
                const n = 1 + Math.round(((reveal - 1) * j) / (J - 1));
                anchors.push([...toFrame(this.gpu, p, n, sum[n] / n), 0]);
            }
            subs.push({ anchors, width: p.lineWidth, rgba: RUN_COLORS[run % RUN_COLORS.length] });
        }
        return subs;
    }

    /**
     * 收敛带：y = p ± σ/√n 之间围出的区域，一条闭合子路径
     * （上边界从左到右、下边界从右到左，填充三趟会把它填上）。
     * σ = √(p(1−p)) 是伯努利分布的标准差；这条带的宽度正是「经验均值的标准误」。
     */
    #llnBand() {
        const p = this.params;
        const N = Math.max(2, Math.round(p.samples));
        const reveal = Math.max(2, Math.ceil(N * this.grow));
        const sigma = Math.sqrt(Math.max(1e-9, p.prob * (1 - p.prob)));
        const J = Math.min(BAND_POINTS, reveal);

        const up = [];
        const lo = [];
        for (let j = 0; j < J; j++) {
            const n = 1 + Math.round(((reveal - 1) * j) / (J - 1));
            const half = sigma / Math.sqrt(n);
            up.push([...toFrame(this.gpu, p, n, p.prob + half), 0]);
            lo.push([...toFrame(this.gpu, p, n, p.prob - half), 0]);
        }
        lo.reverse();
        return [{ anchors: [...up, ...lo], width: 1, rgba: COLORS.band }];
    }

    /** 真值线 y = p */
    #llnMeanLine() {
        const p = this.params;
        const N = Math.max(2, Math.round(p.samples));
        const reveal = Math.max(2, Math.ceil(N * this.grow));
        return [{
            anchors: [
                [...toFrame(this.gpu, p, 0, p.prob), 0],
                [...toFrame(this.gpu, p, reveal, p.prob), 0],
            ],
            width: 2, rgba: COLORS.mean,
        }];
    }

    // ── 中心极限定理 ──────────────────────────────

    /**
     * 均匀数矩阵 + 行前缀和，缓存起来。
     *
     * 矩阵是 M × MAX_N（M 组实验、每组 MAX_N 个均匀数），行前缀和让
     * 「前 n 个之和」变成一次减法。缓存的键是种子与样本数：
     * 改变 n 不会重新抽数，于是 n 增长时直方图是**同一个分布在变形**，
     * 而不是每帧换一批样本乱跳。
     */
    #uniformMatrix() {
        const p = this.params;
        const M = Math.max(50, Math.round(p.samples));
        const key = `${Math.round(p.seed)}|${M}`;
        if (this._uniformKey !== key) {
            const rng = prng(mixSeed(p.seed));
            const rowStride = MAX_N + 1;
            const prefix = new Float32Array(M * rowStride);
            const row = new Float32Array(MAX_N);
            for (let r = 0; r < M; r++) {
                for (let i = 0; i < MAX_N; i++) row[i] = rng();
                const base = r * rowStride;
                let acc = 0;
                for (let i = 0; i < MAX_N; i++) {
                    acc += row[i];
                    prefix[base + i + 1] = acc;
                }
            }
            this._uniform = { M, prefix };
            this._uniformKey = key;
        }
        return this._uniform;
    }

    /**
     * 一组标准化样本 Z = (ΣXᵢ − n·μ) / √(n·σ²)，X ~ 均匀(0,1)：
     * μ = 1/2、σ² = 1/12，所以 Z = (Sₙ − n/2) / √(n/12)。
     * 返回 [M, counts, binWidth]，counts 是落在 [-4, 4] 上等宽小格里的个数。
     */
    #cltHistogram() {
        const p = this.params;
        const { M, prefix } = this.#uniformMatrix();
        const n = clampInt(p.variables, 1, MAX_N);
        const B = clampInt(p.bins, 4, 240);
        const [z0, z1] = HIST_RANGE;
        const w = (z1 - z0) / B;
        const mean = n / 2;
        const sd = Math.sqrt(n / 12);
        const rowStride = MAX_N + 1;

        const counts = new Float64Array(B);
        for (let r = 0; r < M; r++) {
            const z = (prefix[r * rowStride + n] - mean) / sd;
            if (!(z >= z0 && z < z1)) continue;   // 4σ 之外（概率 < 1e-4），不进柱
            const b = Math.min(B - 1, Math.floor((z - z0) / w));
            counts[b] += 1;
        }
        return { M, counts, binWidth: w };
    }

    /** 直方图柱（每根是一条闭合子路径，所以既能填充也能自己绕一圈描边） */
    #cltBars(rgba = COLORS.bars, width = 1.2) {
        const p = this.params;
        const { M, counts, binWidth } = this.#cltHistogram();
        const [z0] = HIST_RANGE;
        const subs = [];
        for (let b = 0; b < counts.length; b++) {
            // 归一化成密度：除以「总样本数 × 格宽」，才能与 φ(z) 直接比高低
            const h = counts[b] / (M * binWidth);
            if (!(h > 0)) continue;
            const xl = z0 + b * binWidth;
            const xr = xl + binWidth;
            subs.push({
                anchors: [
                    [...toFrame(this.gpu, p, xl, 0), 0],
                    [...toFrame(this.gpu, p, xr, 0), 0],
                    [...toFrame(this.gpu, p, xr, h), 0],
                    [...toFrame(this.gpu, p, xl, h), 0],
                    [...toFrame(this.gpu, p, xl, 0), 0],
                ],
                width, rgba,
            });
        }
        return subs;
    }

    /** 柱轮廓：让相邻的柱子之间有条缝看得见（填充色一致时否则会连成一片） */
    #cltBarOutlines() {
        return this.#cltBars(COLORS.barEdge, 1);
    }

    /** 标准正态密度 φ(z) = e^(−z²/2)/√(2π)，叠在直方图上比高低 */
    #normalCurve() {
        const p = this.params;
        const [z0, z1] = HIST_RANGE;
        const anchors = [];
        for (let i = 0; i <= NORMAL_POINTS; i++) {
            const z = z0 + ((z1 - z0) * i) / NORMAL_POINTS;
            const y = Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
            anchors.push([...toFrame(this.gpu, p, z, y), 0]);
        }
        return [{ anchors, width: p.lineWidth, rgba: COLORS.normal }];
    }

    // ── 随机游走 ──────────────────────────────────

    /**
     * 若干个独立的二维随机游走。
     *
     * 每一步在单位圆上均匀取一个方向、走固定步长（各向同性随机游走）。
     * 每个个体用「种子 + 编号」派生自己的随机流，因此互不相关；
     * 揭示长度（grow）只截取前缀，于是播放时路径是长出来的。
     *
     * 锚点数受 WALK_MAX_POINTS 限制：步数拉满时隔着取点。这条折线本来就是在
     * 格子尺度上抖动的，隔点采样后看起来仍是同一条游走，但顶点数少一个量级
     * （每段曲线着色器要展开 186 个顶点，点数直接决定帧成本）。
     */
    #walkPaths() {
        const p = this.params;
        const W = clampInt(p.walkers, 1, 12);
        const steps = Math.max(2, Math.round(p.walkSteps));
        const s = Math.max(1e-3, p.stepLength);
        const total = Math.max(2, Math.ceil(steps * this.grow));
        const stride = Math.max(1, Math.ceil(total / WALK_MAX_POINTS));

        const subs = [];
        for (let w = 0; w < W; w++) {
            const rng = prng(mixSeed(p.seed, w * 7919 + 101));
            const anchors = [];
            let x = 0;
            let y = 0;
            anchors.push([...toFrame(this.gpu, p, 0, 0), 0]);
            for (let k = 1; k <= total; k++) {
                const a = rng() * Math.PI * 2;
                x += s * Math.cos(a);
                y += s * Math.sin(a);
                if (k % stride === 0 || k === total) {
                    anchors.push([...toFrame(this.gpu, p, x, y), 0]);
                }
            }
            if (anchors.length < 2) continue;
            subs.push({
                anchors, width: p.lineWidth,
                rgba: RUN_COLORS[w % RUN_COLORS.length],
            });
        }
        return subs;
    }

    /**
     * 典型距离圆：半径 √n·步长（n 为总步数）。
     * 各向同性随机游走满足 E|R_n|² = n·s²，所以 √n·s 是「走出去多远」的
     * 自然尺度 —— 比最远的 n·s 小得多，这就是 √n 标度。
     */
    #typicalCircle() {
        const p = this.params;
        const R = Math.max(1e-6, p.stepLength) * Math.sqrt(Math.max(1, p.walkSteps));
        const anchors = [];
        for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
            const a = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
            anchors.push([...toFrame(this.gpu, p, R * Math.cos(a), R * Math.sin(a)), 0]);
        }
        return { anchors, width: 1.5, rgba: COLORS.circle };
    }

    // ── 相机与交互 ────────────────────────────────

    /** 几何画在帧坐标里，相机保持正对原点即可 */
    applyCamera() {
        this.gpu.camera.theta = 0;
        this.gpu.camera.phi = 0;
        this.gpu.camera.zoom = 1;
        this.gpu.camera.center = [0, 0, 0];
    }

    /** 拖拽平移 / 滚轮缩放 / 双击复位（实现见 axes.js） */
    handleCanvasEvent(e, ctx) {
        handlePanZoomReset(this, e, ctx);
    }

    /**
     * 播放：
     *   大数定律    逐帧加长已揭示的试验次数 → 曲线从左边长出来（长满后换一颗种子重来）
     *   中心极限定理 n 从 1 加到 24 再回到 1 → 直方图一步步变成钟形
     *   随机游走    逐帧加长路径（长满后换一颗种子，重新走一条）
     */
    playStep() {
        const p = this.params;
        if (this.preset.kind === 'clt') {
            this._tick += 1;
            if (this._tick % 5 === 0) {
                p.variables = p.variables >= MAX_N ? 1 : p.variables + 1;
            }
        } else if (this.preset.kind === 'lln') {
            this.grow += 0.025;
            if (this.grow > 1) {
                this.grow = 0.06;
                p.seed = p.seed >= 999 ? 1 : p.seed + 1;
            }
        } else {
            this.grow += 0.008;
            if (this.grow > 1) {
                this.grow = 0.03;
                p.seed = p.seed >= 999 ? 1 : p.seed + 1;
            }
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
const intFormat = (v) => String(Math.round(v));

/**
 * 注意：xSpan / samples 在不同预设下量纲完全不同（大数定律的 x 是试验次数，
 * 中心极限定理的 x 是标准化值），所以同名键按 kind 各写一条滑块、各自带量程，
 * 靠 visible 只显示当前预设需要的那条。panel.js 的 sync() 会给两条都回填值，
 * 隐藏的那条即使被钳到量程内也不影响 params。
 */
const PANEL = [
    { type: 'section', labelKey: 'section.basic' },

    // 大数定律
    {
        type: 'slider', key: 'prob', labelKey: 'ctrl.prob',
        min: 0.05, max: 0.95, step: 0.01, format: (v) => v.toFixed(2),
        visible: kindIs('lln'),
    },
    {
        type: 'slider', key: 'samples', labelKey: 'ctrl.samples',
        min: 100, max: 4000, step: 10, round: Math.round, format: intFormat,
        visible: kindIs('lln'),
    },
    {
        type: 'slider', key: 'runs', labelKey: 'ctrl.runs',
        min: 1, max: 6, step: 1, round: Math.round, format: intFormat,
        visible: kindIs('lln'),
    },

    // 中心极限定理
    {
        type: 'slider', key: 'variables', labelKey: 'ctrl.variables',
        min: 1, max: MAX_N, step: 1, round: Math.round, format: intFormat,
        visible: kindIs('clt'),
    },
    {
        type: 'slider', key: 'bins', labelKey: 'ctrl.bins',
        min: 8, max: 80, step: 1, round: Math.round, format: intFormat,
        visible: kindIs('clt'),
    },
    {
        type: 'slider', key: 'samples', labelKey: 'ctrl.samples',
        min: 500, max: 8000, step: 250, round: Math.round, format: intFormat,
        visible: kindIs('clt'),
    },

    // 随机游走
    {
        type: 'slider', key: 'walkers', labelKey: 'ctrl.walkers',
        min: 1, max: 12, step: 1, round: Math.round, format: intFormat,
        visible: kindIs('walk'),
    },
    {
        type: 'slider', key: 'walkSteps', labelKey: 'ctrl.walkSteps',
        min: 50, max: 4000, step: 10, round: Math.round, format: intFormat,
        visible: kindIs('walk'),
    },
    {
        type: 'slider', key: 'stepLength', labelKey: 'ctrl.stepLength',
        min: 0.2, max: 3, step: 0.05, format: (v) => v.toFixed(2),
        visible: kindIs('walk'),
    },

    // 随机种子（三个预设共用：换一颗种子就是「再做一次实验」）
    {
        type: 'slider', key: 'seed', labelKey: 'ctrl.seed',
        min: 1, max: 999, step: 1, round: Math.round, format: intFormat,
    },

    { type: 'section', labelKey: 'section.display' },
    { type: 'check', key: 'showBand', labelKey: 'ctrl.showBand', visible: kindIs('lln') },
    { type: 'check', key: 'showCircle', labelKey: 'ctrl.showCircle', visible: kindIs('walk') },

    { type: 'section', labelKey: 'section.view' },
    {
        type: 'slider', key: 'xSpan', labelKey: 'ctrl.xSpan',
        min: 20, max: 4000, step: 10, format: (v) => v.toFixed(0),
        visible: kindIs('lln'),
    },
    {
        type: 'slider', key: 'xSpan', labelKey: 'ctrl.xSpan',
        min: 2, max: 20, step: 0.2, format: (v) => v.toFixed(1),
        visible: kindIs('clt'),
    },
    {
        type: 'slider', key: 'xSpan', labelKey: 'ctrl.xSpan',
        min: 10, max: 400, step: 1, format: (v) => v.toFixed(0),
        visible: kindIs('walk'),
    },
    {
        // 大数定律与中心极限定理的 y 量纲也不同（概率 / 密度），同样各写一条
        type: 'slider', key: 'ySpan', labelKey: 'ctrl.ySpan',
        min: 0.1, max: 3, step: 0.01, format: (v) => v.toFixed(2),
        visible: (p, inst) => kindIs('lln', 'clt')(p, inst) && !p.keepAspect,
    },
    { type: 'check', key: 'keepAspect', labelKey: 'ctrl.keepAspect' },
    {
        type: 'slider', key: 'lineWidth', labelKey: 'ctrl.lineWidth',
        min: 0.5, max: 6, step: 0.1, format: (v) => v.toFixed(1),
    },
];

/** 模块描述符 —— 注册进 registry.js 即出现在侧栏 */
export const randomModule = {
    id: 'random',
    nameKey: 'module.random',
    presets: PRESETS,
    panel: PANEL,
    create: (gpu) => new RandomModule(gpu),
};
