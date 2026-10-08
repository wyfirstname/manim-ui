/**
 * 线性变换 —— 第七个模块
 *
 * 一句话：一个 2×2 矩阵到底对平面做了什么？把网格和单位正方形一起
 * 按矩阵搬一遍，答案就摆在眼前。
 *
 * ── 画面上有四种东西 ──
 *   原网格        灰，固定不动，是"参考系"
 *   变换后网格    两种颜色的两族直线，矩阵作用之后的样子
 *   单位正方形    填充色块，面积就是 |det M|；**行列式为负时换成另一种颜色**，
 *                 因为负行列式意味着平面被翻了个面（定向反转）
 *   基向量箭头    ê₁ 与 ê₂ 的像，其实就是矩阵的两列 —— 它们是理解
 *                 "矩阵每一列都是基向量的落点"最直接的证据
 *
 * ── 预设为什么是这四个 ──
 *   旋转  M = [[cosθ, −sinθ], [sinθ, cosθ]]，det = 1，面积不变，平面被整体转
 *   剪切  M = [[1, k], [0, 1]]，det = 1，面积不变但形状被"推歪" ——
 *         说明"面积不变"远不等于"形状不变"
 *   缩放  M = [[sx, 0], [0, sy]]，det = sx·sy，最简单的情形
 *   奇异  det = 0，整个平面被拍扁到一条直线上，信息不可逆 ——
 *         这正是"没有逆矩阵"的几何含义
 *
 * ── 播放 = 把矩阵"长"出来 ──
 *   M(t) = (1 − t)·I + t·M，t 从 0 走到 1。
 *   全程是**连续**的线性变换，你能亲眼看着正方形被逐步推倒、拉长、压扁。
 *   注意 t < 1 时中间过程未必是原预设那一类变换（比如旋转的插值是"缩着转"），
 *   但这恰恰说明了几何直觉：矩阵是连续搬动平面的那个东西。
 *
 * ── 图层 ──
 *   L_BACK    原网格 + 坐标轴      （描边）
 *   L_FILL    单位正方形的像        （填充三趟）
 *   L_FRONT   变换后网格 + 基向量箭头（描边）
 *
 * 与函数绘图器 / 向量场共用 axes.js 的坐标映射、坐标轴与平移缩放。
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
    gridX: [0.345, 0.769, 0.867, 0.85],   // 蓝：竖线的像
    gridY: [0.514, 0.757, 0.404, 0.85],   // 绿：横线的像
    square: [0.345, 0.769, 0.867, 0.30],  // 蓝，半透明
    flipped: [0.988, 0.384, 0.333, 0.30], // 红：行列式为负（定向反转）
    e1: [0.514, 0.757, 0.404, 1],         // 绿：ê₁ 的像
    e2: [0.988, 0.384, 0.333, 1],         // 红：ê₂ 的像
    unit: [0.72, 0.75, 0.80, 0.55],       // 浅灰：原来的单位正方形轮廓
};

/** 图层编号 */
const L_BACK = 0;
const L_FILL = 1;
const L_FRONT = 2;
const LAYER_COUNT = 3;

/** stroke.wgsl 里那一行常量：填充边框把它翻成 true 再编译一遍（见 shader-loader.js） */
const BORDER_DECL = 'const IS_FILL_BORDER: bool = false;';

/** 网格线向视野外延伸的倍数（长一点，变换后仍然铺满画面） */
const GRID_MARGIN = 1.6;
/** 网格线密度：视野被切成多少格 */
const GRID_DIVISIONS = 8;
/** 网格线最多画多少条（矩阵奇异时格子会被拉得很密，这里兜个底） */
const GRID_MAX_LINES = 80;
/** 箭头头部长度相对向量长度的比例与上限 */
const ARROW_HEAD = 0.22;

const COMMON = {
    a: 1, b: 0, c: 0, d: 1,
    angle: 30,       // 旋转预设用（度）
    shear: 0.6,      // 剪切预设用
    sx: 1.5, sy: 0.8, // 缩放预设用
    t: 1,            // 动画进度：0 = 单位阵，1 = 目标矩阵
    xSpan: 8, ySpan: 8,
    centerX: 0, centerY: 0, keepAspect: true,
    lineWidth: 2.5,
    showOriginal: true, showGrid: true, showVectors: true,
};

export const PRESETS = [
    {
        id: 'rotate',
        kind: 'rotate',
        nameKey: 'preset.rotate.name',
        hintKey: 'preset.rotate.hint',
        params: { ...COMMON, angle: 30 },
    },
    {
        id: 'shear',
        kind: 'shear',
        nameKey: 'preset.shear.name',
        hintKey: 'preset.shear.hint',
        params: { ...COMMON, shear: 0.6 },
    },
    {
        id: 'scale2d',
        kind: 'scale',
        nameKey: 'preset.scale2d.name',
        hintKey: 'preset.scale2d.hint',
        params: { ...COMMON, sx: 1.5, sy: 0.8 },
    },
    {
        id: 'singular',
        kind: 'free',
        nameKey: 'preset.singular.name',
        hintKey: 'preset.singular.hint',
        params: { ...COMMON, a: 1, b: 0.5, c: 0.5, d: 0.25 },
    },
];

export class MatrixModule {
    constructor(gpu) {
        this.gpu = gpu;
        this.preset = PRESETS[0];
        this.params = { ...this.preset.params };
        this.entries = { line: null, fill: null, cover: null, border: null };
        this.passes = [];
        /** 上一帧的行列式，用于"翻面时换个填充色" */
        this.det = 1;
    }

    get name() {
        return t('module.matrix');
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

        const cam = this.gpu.camera;
        if (p.keepAspect) p.ySpan = p.xSpan * (cam.frameHeight / cam.frameWidth);

        const fillRgba = this.#fillRgba();
        const back = this.#uploadLayer(L_BACK, this.#backdrop());
        const fill = this.#uploadLayer(L_FILL, [this.#unitSquare()], fillRgba);
        const front = this.#uploadLayer(L_FRONT, this.#frontLayer());

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

    // ── 矩阵 ──────────────────────────────────────

    /**
     * 当前生效的矩阵 [a, b, c, d]（列优先：第一列 (a, c) 是 ê₁ 的像）。
     *
     * 预设各自的参数先在**预设层**变成矩阵，再统一做 t 插值 ——
     * 插值放在最后，是为了让"播放"这个动作对四个预设语义完全一致。
     */
    #matrix() {
        const p = this.params;
        let m;
        switch (this.preset.kind) {
            case 'rotate': {
                const th = (p.angle * Math.PI) / 180;
                m = [Math.cos(th), -Math.sin(th), Math.sin(th), Math.cos(th)];
                break;
            }
            case 'shear':
                m = [1, p.shear, 0, 1];
                break;
            case 'scale':
                m = [p.sx, 0, 0, p.sy];
                break;
            default:
                m = [p.a, p.b, p.c, p.d];
        }
        // t = 0 时是单位阵，t = 1 时是目标矩阵
        const k = Math.max(0, Math.min(1.4, p.t));
        return [
            1 + (m[0] - 1) * k,
            0 + (m[1] - 0) * k,
            0 + (m[2] - 0) * k,
            1 + (m[3] - 1) * k,
        ];
    }

    /** 把 (x, y) 用当前矩阵搬一遍 */
    #apply(x, y, m) {
        return [m[0] * x + m[1] * y, m[2] * x + m[3] * y];
    }

    /** 填充色：det < 0 说明平面被翻了面，换个颜色把这件"看不见的事"说清楚 */
    #fillRgba() {
        const m = this.#matrix();
        this.det = m[0] * m[3] - m[1] * m[2];
        const c = this.det < 0 ? COLORS.flipped : COLORS.square;
        return c;
    }

    // ── 几何 ──────────────────────────────────────

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

    /** L_BACK：原来的坐标网格（浅）+ 坐标轴 */
    #backdrop() {
        const p = this.params;
        const subs = buildAxes(this.gpu, p, COLORS);
        if (!p.showOriginal) return subs;

        // 原始网格用比坐标轴更淡的灰，明确它是"参考"而不是主角
        const [x0, x1, y0, y1] = this.#bounds(0);
        const dx = (x1 - x0) / GRID_DIVISIONS;
        const dy = (y1 - y0) / GRID_DIVISIONS;
        for (let i = 0; i <= GRID_DIVISIONS; i++) {
            const gx = toFrame(this.gpu, p, x0 + i * dx, 0)[0];
            subs.push({
                anchors: [[gx, -this.gpu.camera.frameHeight / 2, 0],
                    [gx, this.gpu.camera.frameHeight / 2, 0]],
                width: 1, rgba: COLORS.grid,
            });
            const gy = toFrame(this.gpu, p, 0, y0 + i * dy)[1];
            subs.push({
                anchors: [[-this.gpu.camera.frameWidth / 2, gy, 0],
                    [this.gpu.camera.frameWidth / 2, gy, 0]],
                width: 1, rgba: COLORS.grid,
            });
        }
        return subs;
    }

    /**
     * L_FRONT：变换后的网格 + 基向量箭头。
     *
     * 网格的做法：取视野外扩 GRID_MARGIN 倍的若干条直线，把**端点**用矩阵
     * 搬一遍 —— 线性变换把直线映成直线，所以两个端点就能完全确定这条线。
     * 变换后线段可能远远伸出画面，交给光栅化阶段裁剪即可。
     */
    #frontLayer() {
        const subs = [];
        const m = this.#matrix();
        const p = this.params;
        const [x0, x1, y0, y1] = this.#bounds(GRID_MARGIN);

        if (p.showGrid) {
            const dx = (x1 - x0) / GRID_DIVISIONS;
            const dy = (y1 - y0) / GRID_DIVISIONS;
            const step = dx > 0 ? dx : 1;

            let drawn = 0;
            for (let x = x0; x <= x1 + 1e-9 && drawn < GRID_MAX_LINES; x += step) {
                subs.push(this.#mapLine(x, y0, x, y1, m, COLORS.gridX));
                drawn++;
            }
            for (let y = y0; y <= y1 + 1e-9 && drawn < GRID_MAX_LINES; y += dy) {
                subs.push(this.#mapLine(x0, y, x1, y, m, COLORS.gridY));
                drawn++;
            }
        }

        // 原来的单位正方形轮廓（浅灰），给"变了多少"一个参照
        if (p.showOriginal) {
            subs.push({
                anchors: [
                    [...toFrame(this.gpu, p, 0, 0), 0],
                    [...toFrame(this.gpu, p, 1, 0), 0],
                    [...toFrame(this.gpu, p, 1, 1), 0],
                    [...toFrame(this.gpu, p, 0, 1), 0],
                    [...toFrame(this.gpu, p, 0, 0), 0],
                ],
                width: 1.5, rgba: COLORS.unit,
            });
        }

        if (p.showVectors) {
            subs.push(...this.#basisArrow(1, 0, m, COLORS.e1));
            subs.push(...this.#basisArrow(0, 1, m, COLORS.e2));
        }
        return subs;
    }

    /** 一条参数直线 (x0,y0)-(x1,y1) 在矩阵下的像 */
    #mapLine(x0, y0, x1, y1, m, color) {
        const [ax, ay] = this.#apply(x0, y0, m);
        const [bx, by] = this.#apply(x1, y1, m);
        return {
            anchors: [
                [...toFrame(this.gpu, this.params, ax, ay), 0],
                [...toFrame(this.gpu, this.params, bx, by), 0],
            ],
            width: this.params.lineWidth * 0.8, rgba: color,
        };
    }

    /** 单位正方形的像：仿射像仍是平行四边形，四个锚点即可（首点重复闭合） */
    #unitSquare() {
        const m = this.#matrix();
        const p = this.params;
        const corners = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
        return {
            anchors: corners.map(([x, y]) => {
                const [u, v] = this.#apply(x, y, m);
                return [...toFrame(this.gpu, p, u, v), 0];
            }),
            width: 1.5, rgba: COLORS.square,
        };
    }

    /** 基向量的像：画成箭头（杆 + 两撇），长约等于向量本身 */
    #basisArrow(bx, by, m, color) {
        const p = this.params;
        const [ex, ey] = this.#apply(bx, by, m);
        const len = Math.hypot(ex, ey);
        if (!Number.isFinite(len) || len < 1e-4) return [];

        const ux = ex / len;
        const uy = ey / len;
        const head = Math.min(len * ARROW_HEAD, p.xSpan * 0.06);
        const wing = 0.42;
        const angle = Math.atan2(uy, ux);

        const subs = [{
            anchors: [
                [...toFrame(this.gpu, p, 0, 0), 0],
                [...toFrame(this.gpu, p, ex, ey), 0],
            ],
            width: p.lineWidth * 1.4, rgba: color,
        }];
        for (const s of [1, -1]) {
            const a = angle + Math.PI - s * wing;
            const tipX = ex + head * Math.cos(a);
            const tipY = ey + head * Math.sin(a);
            subs.push({
                anchors: [
                    [...toFrame(this.gpu, p, ex, ey), 0],
                    [...toFrame(this.gpu, p, tipX, tipY), 0],
                ],
                width: p.lineWidth * 1.2, rgba: color,
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

    /** 播放：t 从 0 走到 1（矩阵从单位阵"长"到目标），停一拍再从 0 开始 */
    playStep() {
        const p = this.params;
        p.t += 0.012;
        if (p.t > 1.45) p.t = 0;
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
const kindIs = (...kinds) => (p, inst) => kinds.includes(inst?.preset?.kind);

const PANEL = [
    { type: 'section', labelKey: 'section.matrix' },
    {
        type: 'slider', key: 'angle', labelKey: 'ctrl.angle',
        min: -180, max: 180, step: 1, format: (v) => `${Math.round(v)}°`,
        visible: kindIs('rotate'),
    },
    {
        type: 'slider', key: 'shear', labelKey: 'ctrl.shear',
        min: -2, max: 2, step: 0.02, format: (v) => v.toFixed(2),
        visible: kindIs('shear'),
    },
    {
        type: 'slider', key: 'sx', labelKey: 'ctrl.scaleX',
        min: -2, max: 2, step: 0.02, format: (v) => v.toFixed(2),
        visible: kindIs('scale'),
    },
    {
        type: 'slider', key: 'sy', labelKey: 'ctrl.scaleY',
        min: -2, max: 2, step: 0.02, format: (v) => v.toFixed(2),
        visible: kindIs('scale'),
    },
    {
        type: 'slider', key: 'a', labelKey: 'ctrl.matrixA',
        min: -2, max: 2, step: 0.01, format: (v) => v.toFixed(2),
        visible: kindIs('free'),
    },
    {
        type: 'slider', key: 'b', labelKey: 'ctrl.matrixB',
        min: -2, max: 2, step: 0.01, format: (v) => v.toFixed(2),
        visible: kindIs('free'),
    },
    {
        type: 'slider', key: 'c', labelKey: 'ctrl.matrixC',
        min: -2, max: 2, step: 0.01, format: (v) => v.toFixed(2),
        visible: kindIs('free'),
    },
    {
        type: 'slider', key: 'd', labelKey: 'ctrl.matrixD',
        min: -2, max: 2, step: 0.01, format: (v) => v.toFixed(2),
        visible: kindIs('free'),
    },
    {
        type: 'slider', key: 't', labelKey: 'ctrl.matrixT',
        min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2),
    },
    { type: 'section', labelKey: 'section.display' },
    { type: 'check', key: 'showOriginal', labelKey: 'ctrl.showOriginal' },
    { type: 'check', key: 'showGrid', labelKey: 'ctrl.showGrid' },
    { type: 'check', key: 'showVectors', labelKey: 'ctrl.showVectors' },
    { type: 'section', labelKey: 'section.view' },
    {
        type: 'slider', key: 'xSpan', labelKey: 'ctrl.xSpan',
        min: 2, max: 30, step: 0.5, format: (v) => v.toFixed(1),
    },
    {
        type: 'slider', key: 'ySpan', labelKey: 'ctrl.ySpan',
        min: 2, max: 30, step: 0.5, format: (v) => v.toFixed(1),
        visible: (p) => !p.keepAspect,
    },
    { type: 'check', key: 'keepAspect', labelKey: 'ctrl.keepAspect' },
    {
        type: 'slider', key: 'lineWidth', labelKey: 'ctrl.lineWidth',
        min: 1, max: 6, step: 0.5, format: (v) => v.toFixed(1),
    },
];

/** 模块描述符 —— 注册进 registry.js 即出现在侧栏 */
export const matrixModule = {
    id: 'matrix',
    nameKey: 'module.matrix',
    presets: PRESETS,
    panel: PANEL,
    create: (gpu) => new MatrixModule(gpu),
};
