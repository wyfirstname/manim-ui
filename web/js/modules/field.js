/**
 * 向量场流线 —— 第三个模块
 *
 * 用上游 stroke.wgsl（零改写）画：向量场箭头 + 沿场积分出来的流线。
 *
 * ── 这是个什么样的模块 ──
 * 给定一个平面向量场 F(x, y) = (u, v)，做两件事：
 *   1. 在网格上画一排箭头，箭头方向 = 场方向，长度按格子大小固定
 *      （只编码方向，不编码大小；大小用**颜色**编码，见下）
 *   2. 从若干种子点出发，沿场方向积分出一条积分曲线（流线）
 * 两者的颜色都由**场上该点的速率**（|F|）决定，用蓝 → 青 → 绿 → 黄 的
 * 对数色标。之所以取对数：点源 / 点涡这类场在奇点附近速率趋于无穷，
 * 线性映射会把整幅图都压成最亮的颜色。
 *
 * ── 流线是怎么积出来的 ──
 * 把场**归一化**后做 RK4，步长是固定的弧长：
 *   k1 = dir(p), k2 = dir(p + k1·h/2), k3 = dir(p + k2·h/2), k4 = dir(p + k3·h)
 *   p ← p + (k1 + 2k2 + 2k3 + k4)·h/6
 * 归一化的好处：不管场在局部多大多小，一步总是走同样的弧长，
 * 于是在奇点附近不会一步跳出屏幕，在远处也不会稠到看不出形状。
 * 步长固定为视野的 1/60，因此「流线长度」滑块调的是**步数**而不是步长，
 * 这样拉长流线时形状不会跟着变。每个种子都向前、向后各积一次，
 * 接成一条穿过种子的流线。
 *
 * 种子分布：以视野中心为心、按黄金角错开角度的若干同心位置，
 * 半径从 0.12 到 0.44 倍短边铺开。这样对旋转对称的场（涡、汇）能自然铺满，
 * 对偶极子这类非对称场也有足够覆盖，且不需要任何去重逻辑。
 *
 * ── 图层 ──
 *   L_BACK    网格 / 刻度 / 坐标轴   （描边）
 *   L_ARROWS  向量场箭头             （描边）
 *   L_STREAMS 流线                   （描边）
 * 三层都是描边，共用同一条 stroke.wgsl 管线，因此只有一个 PipelineState。
 * 之所以分三层而不是塞进同一层：后画的层压在先画的层之上，
 * 流线要压在箭头之上，箭头要压在网格之上。
 *
 * 与函数绘图器共用 axes.js 的坐标映射、坐标轴与平移缩放。
 */

import { t } from '../i18n.js';
import {
    VM_OBJECT_FIELDS, VM_STROKE_RECORD,
    VERTS_PER_STROKE_CURVE,
    buildStrokeRecords, setVMObjectDefaults,
} from '../vmobject.js';
import {
    toFrame, buildAxes, handlePanZoomReset,
} from '../axes.js';

const COLORS = {
    grid: [0.24, 0.27, 0.32, 1],
    axis: [0.62, 0.67, 0.74, 1],
    tick: [0.50, 0.55, 0.62, 1],
};

/** 图层编号 */
const L_BACK = 0;
const L_ARROWS = 1;
const L_STREAMS = 2;
const LAYER_COUNT = 3;

/**
 * 速率 -> 颜色的色标（蓝 → 青 → 绿 → 黄）。
 * 每一档是 [位置, RGB]，位置 ∈ [0, 1]。
 */
const SPEED_STOPS = [
    [0.00, [0.24, 0.37, 0.85]],
    [0.35, [0.20, 0.72, 0.82]],
    [0.68, [0.51, 0.85, 0.42]],
    [1.00, [0.99, 0.80, 0.10]],
];

/** 弧长步长 = 短边 / 这个数 */
const STEP_DIVISOR = 60;
/** 流线最大步数上限（防止把流线长度拉满时顶点数失控） */
const MAX_STEPS = 420;

function speedColor(s, alpha = 1) {
    const x = Math.max(0, Math.min(1, Number.isFinite(s) ? s : 0));
    let i = 0;
    while (i < SPEED_STOPS.length - 1 && x > SPEED_STOPS[i + 1][0]) i++;
    const [p0, c0] = SPEED_STOPS[i];
    const [p1, c1] = SPEED_STOPS[Math.min(i + 1, SPEED_STOPS.length - 1)];
    const f = p1 > p0 ? (x - p0) / (p1 - p0) : 0;
    return [
        c0[0] + (c1[0] - c0[0]) * f,
        c0[1] + (c1[1] - c0[1]) * f,
        c0[2] + (c1[2] - c0[2]) * f,
        alpha,
    ];
}

const COMMON = {
    arrowScale: 0.85, arrowDensity: 12,
    streamSeeds: 10, traceLength: 1.2,
    showArrows: true, showStreams: true,
    lineWidth: 2.5, keepAspect: true,
    centerX: 0, centerY: 0,
};

/** 预设场景 */
export const PRESETS = [
    {
        id: 'vortex',
        kind: 'vortex',
        nameKey: 'preset.vortex.name',
        hintKey: 'preset.vortex.hint',
        params: {
            ...COMMON,
            spin: 1, strength: 1, sep: 1.6,
            xSpan: 8, ySpan: 8,
        },
    },
    {
        id: 'attractor',
        kind: 'attractor',
        nameKey: 'preset.attractor.name',
        hintKey: 'preset.attractor.hint',
        params: {
            ...COMMON,
            spin: 1, strength: 1, sep: 1.6,
            lineWidth: 2.5,
            xSpan: 8, ySpan: 8,
        },
    },
    {
        id: 'dipole',
        kind: 'dipole',
        nameKey: 'preset.dipole.name',
        hintKey: 'preset.dipole.hint',
        params: {
            ...COMMON,
            spin: 1, strength: 1, sep: 1.6,
            streamSeeds: 12, arrowDensity: 13,
            xSpan: 10, ySpan: 10,
        },
    },
    {
        id: 'dualvortex',
        kind: 'dualvortex',
        nameKey: 'preset.dualvortex.name',
        hintKey: 'preset.dualvortex.hint',
        params: {
            ...COMMON,
            spin: 1, strength: 1, sep: 1.8,
            streamSeeds: 12, arrowDensity: 13,
            xSpan: 10, ySpan: 10,
        },
    },
];

export class FieldModule {
    constructor(gpu) {
        this.gpu = gpu;
        this.preset = PRESETS[0];
        this.params = { ...this.preset.params };
        this.entries = { line: null };
        this.passes = [];

        // 缩放下限（可以放得比函数绘图器更近，方便看奇点附近）
        this.minSpan = 0.6;
        // 播放时流线的「生长」系数：0 起步、1 长满
        this.growth = 1;
        // 速率色标的参考值（每帧重算）
        this.speedRef = 1;
    }

    get name() {
        return t('module.field');
    }

    get lineEntry() { return this.entries.line; }

    // ── 载入与更新 ────────────────────────────────

    async loadPreset(presetId) {
        const p = PRESETS.find((x) => x.id === presetId);
        if (!p) throw new Error(`未知预设：${presetId}`);
        this.preset = p;
        this.params = { ...p.params };
        this.growth = 1;

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
        // 等比：让纵向范围跟随横向范围，避免箭头被压扁成难看的长方形
        if (p.keepAspect) p.ySpan = p.xSpan * (cam.frameHeight / cam.frameWidth);

        this.speedRef = this.#measureSpeed();

        const back = this.#uploadLayer(L_BACK, buildAxes(this.gpu, p, COLORS));
        const arrows = p.showArrows
            ? this.#uploadLayer(L_ARROWS, this.#arrowSubpaths())
            : 0;
        const streams = p.showStreams
            ? this.#uploadLayer(L_STREAMS, this.#streamSubpaths())
            : 0;

        const passes = [];
        if (back > 0) {
            passes.push({ entry: this.entries.line, layer: L_BACK, vertexCount: back * VERTS_PER_STROKE_CURVE });
        }
        if (arrows > 0) {
            passes.push({ entry: this.entries.line, layer: L_ARROWS, vertexCount: arrows * VERTS_PER_STROKE_CURVE });
        }
        if (streams > 0) {
            passes.push({ entry: this.entries.line, layer: L_STREAMS, vertexCount: streams * VERTS_PER_STROKE_CURVE });
        }
        this.passes = passes;
    }

    /**
     * 把一组子路径写进某一层，返回这层的曲线数。
     * @param {number} index 图层号
     * @param {Array} subpaths
     */
    #uploadLayer(index, subpaths) {
        const layer = this.gpu.layer(index);
        if (!layer) return 0;
        setVMObjectDefaults(layer.block);
        layer.block.upload(this.gpu.device, layer.buffer);

        const rec = buildStrokeRecords(subpaths);
        this.gpu.uploadRecords(rec.data, index);
        return rec.curveCount;
    }

    // ── 视野与场 ──────────────────────────────────

    /** 视野范围 [x0, x1, y0, y1]，margin 为相对半宽的额外余量 */
    #bounds(margin = 0) {
        const p = this.params;
        const mx = (p.xSpan / 2) * margin;
        const my = (p.ySpan / 2) * margin;
        return [
            p.centerX - p.xSpan / 2 - mx,
            p.centerX + p.xSpan / 2 + mx,
            p.centerY - p.ySpan / 2 - my,
            p.centerY + p.ySpan / 2 + my,
        ];
    }

    /**
     * 向量场 F(x, y)，定义在数学坐标里（不随视野平移而移动）。
     * @returns {[number, number]} [u, v]
     */
    #fieldAt(x, y) {
        const p = this.params;
        switch (this.preset.kind) {
            // 刚体旋转：F = spin · (−y, x)。流线是一圈圈同心圆。
            case 'vortex':
                return [-p.spin * y, p.spin * x];

            // 线性汇：F = −strength · (x, y)。所有流线都笔直汇向原点。
            case 'attractor':
                return [-p.strength * x, -p.strength * y];

            // 点源(+1) 在 (d, 0)、点汇(−1) 在 (−d, 0)：
            // 点源的场是 (p − p0)/|p − p0|²（这正是二维「源」的速度场）。
            case 'dipole': {
                const d = Math.max(1e-3, p.sep);
                const a1 = x - d, b1 = y;
                const a2 = x + d, b2 = y;
                const r1 = a1 * a1 + b1 * b1 + 1e-9;
                const r2 = a2 * a2 + b2 * b2 + 1e-9;
                return [a1 / r1 - a2 / r2, b1 / r1 - b2 / r2];
            }

            // 两个反向旋转的点涡：左涡逆时针(+1)、右涡顺时针(−1)。
            // 点涡场 = s · (−dy, dx) / r²，中间形成一条向上的通道。
            case 'dualvortex': {
                const d = Math.max(1e-3, p.sep);
                const lx = x + d, ly = y;
                const rx = x - d, ry = y;
                const rl = lx * lx + ly * ly + 1e-9;
                const rr = rx * rx + ry * ry + 1e-9;
                return [-ly / rl + ry / rr, lx / rl - rx / rr];
            }

            default:
                return [0, 0];
        }
    }

    /**
     * 视野内速率的参考上界（用于对数色标）。
     *
     * 取**采样速率的高分位**而不是最大值：点涡、点源这类场在奇点附近速率
     * 趋于无穷，而采样网格偶尔会有一格恰好落在离奇点极近的地方，
     * 用最大值定标会把整幅图都压成最暗的颜色（B3 首版在「双涡」上就翻过车）。
     */
    #measureSpeed() {
        const [x0, x1, y0, y1] = this.#bounds(0);
        const N = 28;
        const speeds = [];
        for (let i = 0; i <= N; i++) {
            for (let j = 0; j <= N; j++) {
                const x = x0 + ((x1 - x0) * i) / N;
                const y = y0 + ((y1 - y0) * j) / N;
                const [u, v] = this.#fieldAt(x, y);
                const m = Math.hypot(u, v);
                if (Number.isFinite(m) && m > 0) speeds.push(m);
            }
        }
        if (!speeds.length) return 1;
        speeds.sort((a, b) => a - b);
        const ref = speeds[Math.min(speeds.length - 1, Math.floor(speeds.length * 0.92))];
        return Math.max(ref, 1e-3);
    }

    /** 速率 -> [0, 1]（对数尺度） */
    #normSpeed(m) {
        const ref = this.speedRef > 0 ? this.speedRef : 1;
        return Math.log1p(Math.max(0, m)) / Math.log1p(ref);
    }

    // ── 几何：箭头 ────────────────────────────────

    /** L_ARROWS：网格上的箭头，方向 = 场方向，颜色 = 速率 */
    #arrowSubpaths() {
        const p = this.params;
        const n = Math.max(3, Math.round(p.arrowDensity));
        const [x0, x1, y0, y1] = this.#bounds(0);
        const cw = (x1 - x0) / n;
        const ch = (y1 - y0) / n;
        const len = p.arrowScale * Math.min(cw, ch) * 0.9;
        const wingLen = len * 0.38;
        const wing = 0.45; // 箭头张角（弧度）

        const subs = [];
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                const x = x0 + (i + 0.5) * cw;
                const y = y0 + (j + 0.5) * ch;
                const [u, v] = this.#fieldAt(x, y);
                const m = Math.hypot(u, v);
                if (!Number.isFinite(m) || m < 1e-7) continue;
                const ux = u / m;
                const uy = v / m;
                const hl = len / 2;
                const tail = [x - ux * hl, y - uy * hl];
                const head = [x + ux * hl, y + uy * hl];
                const col = speedColor(this.#normSpeed(m), 0.95);
                const angle = Math.atan2(uy, ux);

                subs.push({
                    anchors: [[...toFrame(this.gpu, p, tail[0], tail[1]), 0],
                        [...toFrame(this.gpu, p, head[0], head[1]), 0]],
                    width: p.lineWidth, rgba: col,
                });
                for (const s of [1, -1]) {
                    const a = angle + Math.PI - s * wing;
                    const tip = [head[0] + wingLen * Math.cos(a), head[1] + wingLen * Math.sin(a)];
                    subs.push({
                        anchors: [[...toFrame(this.gpu, p, head[0], head[1]), 0],
                            [...toFrame(this.gpu, p, tip[0], tip[1]), 0]],
                        width: p.lineWidth * 0.85, rgba: col,
                    });
                }
            }
        }
        return subs;
    }

    // ── 几何：流线 ────────────────────────────────

    /** L_STREAMS：从种子点沿场积分出来的流线 */
    #streamSubpaths() {
        const p = this.params;
        const minSpan = Math.min(p.xSpan, p.ySpan);
        const dt = minSpan / STEP_DIVISOR;
        const steps = Math.max(
            1,
            Math.min(MAX_STEPS, Math.round(p.traceLength * 150 * this.growth)),
        );

        const subs = [];
        for (const [sx, sy] of this.#seeds()) {
            const pts = this.#streamline(sx, sy, steps, dt);
            if (pts.length < 4) continue;
            const anchors = [];
            const rgba = [];
            for (const [x, y, m] of pts) {
                const [fx, fy] = toFrame(this.gpu, p, x, y);
                if (!Number.isFinite(fx) || !Number.isFinite(fy)) continue;
                anchors.push([fx, fy, 0]);
                rgba.push(speedColor(this.#normSpeed(m), 1));
            }
            if (anchors.length < 4) continue;
            subs.push({ anchors, width: p.lineWidth, rgba });
        }
        return subs;
    }

    /** 种子点：以视野中心为心、按黄金角错开角度铺开的同心位置 */
    #seeds() {
        const p = this.params;
        const n = Math.max(1, Math.round(p.streamSeeds));
        const minSpan = Math.min(p.xSpan, p.ySpan);
        const rMin = 0.12 * minSpan;
        const rMax = 0.44 * minSpan;
        const GOLDEN = Math.PI * (3 - Math.sqrt(5));

        const out = [];
        for (let i = 0; i < n; i++) {
            const f = n === 1 ? 0 : i / (n - 1);
            const r = rMin + (rMax - rMin) * f;
            const a = GOLDEN * i;
            out.push([p.centerX + r * Math.cos(a), p.centerY + r * Math.sin(a)]);
        }
        return out;
    }

    /** 穿过种子点的一条流线：向后积一段、向前积一段，接起来 */
    #streamline(x0, y0, steps, dt) {
        const bwd = this.#trace(x0, y0, -1, steps, dt);
        const fwd = this.#trace(x0, y0, +1, steps, dt);
        const pts = [];
        for (let i = bwd.length - 1; i >= 0; i--) pts.push(bwd[i]);
        for (let i = 1; i < fwd.length; i++) pts.push(fwd[i]);
        return pts;
    }

    /**
     * 沿场积分一条积分曲线（归一化场 + 定步长 RK4）。
     * @param {number} sign +1 顺场、-1 逆场
     * @returns {Array<[number, number, number]>} 每点是 [x, y, 该点速率]
     */
    #trace(x0, y0, sign, steps, dt) {
        const [bx0, bx1, by0, by1] = this.#bounds(0.35);
        const pts = [];

        const dirAt = (x, y) => {
            const [u, v] = this.#fieldAt(x, y);
            const m = Math.hypot(u, v);
            if (!Number.isFinite(m) || m < 1e-7) return null;
            return [(sign * u) / m, (sign * v) / m];
        };

        let x = x0;
        let y = y0;
        for (let i = 0; i < steps; i++) {
            const [u, v] = this.#fieldAt(x, y);
            const speed = Math.hypot(u, v);
            if (!Number.isFinite(speed)) break;
            pts.push([x, y, speed]);

            const d1 = dirAt(x, y);
            if (!d1) break;
            const d2 = dirAt(x + (d1[0] * dt) / 2, y + (d1[1] * dt) / 2) ?? d1;
            const d3 = dirAt(x + (d2[0] * dt) / 2, y + (d2[1] * dt) / 2) ?? d1;
            const d4 = dirAt(x + d3[0] * dt, y + d3[1] * dt) ?? d1;
            const ex = (d1[0] + 2 * d2[0] + 2 * d3[0] + d4[0]) / 6;
            const ey = (d1[1] + 2 * d2[1] + 2 * d3[1] + d4[1]) / 6;
            x += ex * dt;
            y += ey * dt;

            if (!Number.isFinite(x) || !Number.isFinite(y)) break;
            if (x < bx0 || x > bx1 || y < by0 || y > by1) {
                pts.push([x, y, speed]);   // 让流线平滑地滑出视野
                break;
            }
        }
        return pts;
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

    /** 播放：流线从种子点一点点「长」出来，演示积分过程 */
    playStep() {
        this.growth += 0.03;
        if (this.growth > 1) this.growth = 0.05;
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

const PANEL = [
    { type: 'section', labelKey: 'section.field' },
    {
        type: 'slider', key: 'spin', labelKey: 'ctrl.spin',
        min: -2, max: 2, step: 0.05, format: (v) => v.toFixed(2),
        visible: kindIs('vortex'),
    },
    {
        type: 'slider', key: 'strength', labelKey: 'ctrl.strength',
        min: 0.2, max: 3, step: 0.05, format: (v) => v.toFixed(2),
        visible: kindIs('attractor'),
    },
    {
        type: 'slider', key: 'sep', labelKey: 'ctrl.sep',
        min: 0.4, max: 3, step: 0.05, format: (v) => v.toFixed(2),
        visible: kindIs('dipole', 'dualvortex'),
    },
    {
        type: 'slider', key: 'arrowScale', labelKey: 'ctrl.arrowScale',
        min: 0.2, max: 1.5, step: 0.05, format: (v) => v.toFixed(2),
    },
    {
        type: 'slider', key: 'arrowDensity', labelKey: 'ctrl.arrowDensity',
        min: 4, max: 24, step: 1,
        format: (v) => String(Math.round(v)),
    },
    {
        type: 'slider', key: 'streamSeeds', labelKey: 'ctrl.streamSeeds',
        min: 2, max: 30, step: 1,
        format: (v) => String(Math.round(v)),
    },
    {
        type: 'slider', key: 'traceLength', labelKey: 'ctrl.traceLength',
        min: 0.3, max: 3, step: 0.05, format: (v) => v.toFixed(2),
    },
    { type: 'section', labelKey: 'section.display' },
    { type: 'check', key: 'showArrows', labelKey: 'ctrl.showArrows' },
    { type: 'check', key: 'showStreams', labelKey: 'ctrl.showStreams' },
    { type: 'section', labelKey: 'section.view' },
    {
        type: 'slider', key: 'xSpan', labelKey: 'ctrl.xSpan',
        min: 1, max: 40, step: 0.5, format: (v) => v.toFixed(1),
    },
    {
        type: 'slider', key: 'ySpan', labelKey: 'ctrl.ySpan',
        min: 1, max: 40, step: 0.5, format: (v) => v.toFixed(1),
        visible: (p) => !p.keepAspect,
    },
    { type: 'check', key: 'keepAspect', labelKey: 'ctrl.keepAspect' },
    {
        type: 'slider', key: 'lineWidth', labelKey: 'ctrl.lineWidth',
        min: 1, max: 6, step: 0.5, format: (v) => v.toFixed(1),
    },
];

/** 模块描述符 —— 注册进 registry.js 即出现在侧栏 */
export const fieldModule = {
    id: 'field',
    nameKey: 'module.field',
    presets: PRESETS,
    panel: PANEL,
    create: (gpu) => new FieldModule(gpu),
};
