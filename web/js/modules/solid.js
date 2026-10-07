/**
 * 三维几何 —— 第四个模块
 *
 * 用上游 surface.wgsl（零改写）画真正的三维曲面，鼠标轨道旋转观察。
 *
 * ── 曲面怎么送进去 ──
 * 上游不给曲面传三角面索引，而是**交一张点阵**：resolution.x 行 × resolution.y 列，
 * 网格由 surface_mesh.wgsl 在顶点着色器里现推 —— 每格拆两个三角形，每个顶点问
 * 「我是哪一格的哪个角」。法线也是从相邻点差分现叉出来的，所以球极点那种
 * 「一整行退化成同一个点」的网格会自动改用旁边的行。
 * 因此这一侧只需要按行优先把点阵与颜色铺平，**没有任何拓扑要维护**。
 *
 * 还有一条分支：resolution.x == 0 时点阵被当成**裸三角面列表**（三个记录一个面），
 * 法线由该面自己的三个点叉出来 —— 二十面体走的就是这条路，于是天然是平面着色。
 *
 * ── 透视是怎么来的 ──
 * project_point.wgsl 里 w = 1 − scaled.z，而 frame_rescale_factors.z = scale/焦距，
 * 于是 w = 点到相机的距离 / 焦距 —— 近的点 w 小、NDC 大，这就是投影本身。
 * 所以打开透视只需要相机给出一个有限焦距，不需要额外的投影矩阵。
 *
 * ── 图层 ──
 *   L_AXES  坐标轴（stroke.wgsl，深写）—— 有个地面参照，三维感才立得住
 *   L_SOLID 曲面（surface.wgsl，深度测试 + 深写）
 *   L_LINES 网格线（stroke.wgsl，less-equal、不写深度）—— 压在曲面表面上
 * 三层的 mobject uniform 用的是同一份**并集**布局（描边那 16 个字段 + resolution），
 * 各自没用到的成员白放着即可，这样同一个模块里能同时跑两种 mobject 类型。
 *
 * 屏幕空间：拖拽 = 转动物体，滚轮 = 推近拉远，双击 = 回到预设视角。
 */

import { t } from '../i18n.js';
import {
    VM_OBJECT_FIELDS, VM_STROKE_RECORD, VERTS_PER_STROKE_CURVE,
    buildStrokeRecords, setVMObjectDefaults,
    VM_SURFACE_RECORD, VERTS_PER_SURFACE_SQUARE,
    buildSurfaceRecords, setSurfaceDefaults,
} from '../vmobject.js';
import { PipelineState } from '../pipeline.js';

/** 描边用到的字段 + 曲面用到的 resolution，并集喂给所有图层 */
const SOLID_FIELDS = [
    ...VM_OBJECT_FIELDS,
    { name: 'resolution', type: 'vec2f' },
];

const L_AXES = 0;
const L_SOLID = 1;
const L_LINES = 2;
const LAYER_COUNT = 3;

const AXIS_COLORS = {
    x: [0.90, 0.36, 0.42, 0.95],
    y: [0.44, 0.80, 0.40, 0.95],
    z: [0.38, 0.62, 0.95, 0.95],
};

const WIRE_COLOR = [0.90, 0.93, 0.97, 0.45];

/** 高度 -> 颜色（蓝 → 青 → 绿 → 琥珀），与向量场模块同一套口味 */
const PALETTE = [
    [0.00, [0.19, 0.44, 0.86]],
    [0.35, [0.18, 0.74, 0.73]],
    [0.70, [0.60, 0.82, 0.36]],
    [1.00, [0.98, 0.72, 0.16]],
];

function palette(t01, alpha = 1) {
    const x = Math.max(0, Math.min(1, Number.isFinite(t01) ? t01 : 0));
    let i = 0;
    while (i < PALETTE.length - 1 && x > PALETTE[i + 1][0]) i++;
    const [p0, c0] = PALETTE[i];
    const [p1, c1] = PALETTE[Math.min(i + 1, PALETTE.length - 1)];
    const f = p1 > p0 ? (x - p0) / (p1 - p0) : 0;
    return [
        c0[0] + (c1[0] - c0[0]) * f,
        c0[1] + (c1[1] - c0[1]) * f,
        c0[2] + (c1[2] - c0[2]) * f,
        alpha,
    ];
}

/** 拖拽每像素转多少弧度；φ 的上下限（避开 ±90° 那个奇异点） */
const ROT_PER_PX = 0.0075;
const PHI_LIMIT = 1.45;

const COMMON = {
    detail: 48,
    radius: 2.0,
    tube: 0.72,
    width: 1.6,
    twists: 1,
    reflect: 0.62,
    gloss: 0.28,
    shadow: 0.5,
    showAxes: true,
    wireframe: false,
    spinRate: 0.5,
};

/** 预设场景 */
export const PRESETS = [
    {
        id: 'sphere',
        shape: 'sphere',
        nameKey: 'preset.sphere.name',
        hintKey: 'preset.sphere.hint',
        view: { theta: 0.6, phi: 1.05, zoom: 1.15 },
        params: { ...COMMON, radius: 2.0, detail: 48 },
    },
    {
        id: 'torus',
        shape: 'torus',
        nameKey: 'preset.torus.name',
        hintKey: 'preset.torus.hint',
        view: { theta: 0.5, phi: 0.95, zoom: 1.05 },
        params: { ...COMMON, radius: 2.0, tube: 0.72, detail: 56, wireframe: true },
    },
    {
        id: 'mobius',
        shape: 'mobius',
        nameKey: 'preset.mobius.name',
        hintKey: 'preset.mobius.hint',
        view: { theta: 1.0, phi: 1.2, zoom: 1.05 },
        params: { ...COMMON, radius: 1.8, width: 1.6, twists: 1, detail: 64 },
    },
    {
        id: 'icosa',
        shape: 'icosa',
        nameKey: 'preset.icosa.name',
        hintKey: 'preset.icosa.hint',
        view: { theta: 0.35, phi: 1.05, zoom: 1.25 },
        params: { ...COMMON, radius: 2.0, wireframe: false },
    },
];

class SolidModule {
    constructor(gpu) {
        this.gpu = gpu;
        this.preset = PRESETS[0];
        this.params = { ...PRESETS[0].params };
        this.entries = {};
        this.passes = [];
        this.theta = PRESETS[0].view.theta;
        this.phi = PRESETS[0].view.phi;
        this.zoom = PRESETS[0].view.zoom;
    }

    get name() {
        return t('module.solid');
    }

    // ── 载入与更新 ────────────────────────────────

    async loadPreset(presetId) {
        const p = PRESETS.find((x) => x.id === presetId);
        if (!p) throw new Error(`未知预设：${presetId}`);
        this.preset = p;
        this.params = { ...p.params };
        this.theta = p.view.theta;
        this.phi = p.view.phi;
        this.zoom = p.view.zoom;

        this.gpu.setMobjectFields(SOLID_FIELDS, LAYER_COUNT);
        const uniformMembers = this.gpu.mobjectBlock.decl;

        this.entries.solid = await this.gpu.loadPipeline('surface.wgsl', {
            dataLayout: VM_SURFACE_RECORD,
            uniformMembers,
            state: PipelineState.DEPTH,
        });
        this.entries.line = await this.gpu.loadPipeline('stroke.wgsl', {
            dataLayout: VM_STROKE_RECORD,
            uniformMembers,
            state: PipelineState.DEPTH,
        });
        // 同一份源码换一个固定功能状态 —— 上方那一趟是「压在表面上」的网格线
        this.entries.lines = await this.gpu.loadPipeline('stroke.wgsl', {
            dataLayout: VM_STROKE_RECORD,
            uniformMembers,
            state: PipelineState.OVERLAY,
        });
        this.update();
    }

    update() {
        if (!this.gpu.layers.length || !this.entries.solid) return;
        const p = this.params;
        const geo = this.#geometry();

        this.#uploadSurface(geo);

        const axes = p.showAxes ? this.#uploadAxes(this.#extent(geo)) : 0;
        const wires = (p.wireframe && !geo.listMode) ? this.#uploadWire(geo) : 0;

        const passes = [];
        if (axes > 0) {
            passes.push({ entry: this.entries.line, layer: L_AXES, vertexCount: axes * VERTS_PER_STROKE_CURVE });
        }
        passes.push({
            entry: this.entries.solid,
            layer: L_SOLID,
            vertexCount: geo.listMode
                ? geo.points.length
                : VERTS_PER_SURFACE_SQUARE * (geo.rows - 1) * (geo.cols - 1),
        });
        if (wires > 0) {
            passes.push({ entry: this.entries.lines, layer: L_LINES, vertexCount: wires * VERTS_PER_STROKE_CURVE });
        }
        this.passes = passes;
    }

    // ── 上传 ──────────────────────────────────────

    #uploadSurface(geo) {
        const layer = this.gpu.layer(L_SOLID);
        if (!layer) return;
        const p = this.params;
        const rec = buildSurfaceRecords(geo.points, this.#colors(geo));
        setSurfaceDefaults(
            layer.block,
            geo.listMode ? null : [geo.rows, geo.cols],
            [p.reflect, p.gloss, p.shadow],
        );
        layer.block.upload(this.gpu.device, layer.buffer);
        this.gpu.uploadRecords(rec.data, L_SOLID);
    }

    /** 三条坐标轴。3D 场景必须有个地面参照，否则看不出在往哪转。 */
    #uploadAxes(extent) {
        const layer = this.gpu.layer(L_AXES);
        if (!layer) return 0;
        setVMObjectDefaults(layer.block);
        // 与 2D 模块唯一的差别：几何随相机走，所以不吃 view 的豁免
        layer.block.setFloats('is_fixed_in_frame', 0);
        layer.block.setFloats('resolution', [0, 0]);
        layer.block.upload(this.gpu.device, layer.buffer);

        const L = extent * 1.45;
        const back = -L * 0.22;
        const subs = [
            { anchors: [[back, 0, 0], [L, 0, 0]], width: 2.2, rgba: AXIS_COLORS.x },
            { anchors: [[0, back, 0], [0, L, 0]], width: 2.2, rgba: AXIS_COLORS.y },
            { anchors: [[0, 0, back], [0, 0, L]], width: 2.2, rgba: AXIS_COLORS.z },
        ];
        const rec = buildStrokeRecords(subs);
        this.gpu.uploadRecords(rec.data, L_AXES);
        return rec.curveCount;
    }

    /**
     * 网格线：把点阵的每一行、每一列当一条多段线描出来。
     * 每隔 step 条取一条，否则高细分下顶点数会失控。
     */
    #uploadWire(geo) {
        const layer = this.gpu.layer(L_LINES);
        if (!layer) return 0;
        setVMObjectDefaults(layer.block);
        layer.block.setFloats('is_fixed_in_frame', 0);
        layer.block.setFloats('resolution', [0, 0]);
        layer.block.upload(this.gpu.device, layer.buffer);

        const { points, rows, cols } = geo;
        const step = Math.max(1, Math.ceil(Math.max(rows, cols) / 20));
        const subs = [];

        const push = (line) => {
            // 球极点那一整行是同一个点，去掉连续重复后长度不足就整条丢掉
            const out = [];
            for (const q of line) {
                const last = out[out.length - 1];
                if (!last || Math.hypot(q[0] - last[0], q[1] - last[1], q[2] - last[2]) > 1e-6) {
                    out.push(q);
                }
            }
            if (out.length >= 2) subs.push({ anchors: out, width: 1.2, rgba: WIRE_COLOR });
        };

        for (let i = 0; i < rows; i += step) {
            const line = [];
            for (let j = 0; j < cols; j++) line.push(points[i * cols + j]);
            push(line);
        }
        for (let j = 0; j < cols; j += step) {
            const line = [];
            for (let i = 0; i < rows; i++) line.push(points[i * cols + j]);
            push(line);
        }

        const rec = buildStrokeRecords(subs);
        this.gpu.uploadRecords(rec.data, L_LINES);
        return rec.curveCount;
    }

    // ── 颜色 ──────────────────────────────────────

    /**
     * 按高度上色。listMode 下按**面**取色（面心高度），于是二十面体是平面着色，
     * 球与环面则是逐点取色、自然渐变。
     */
    #colors(geo) {
        const pts = geo.points;
        let zmin = Infinity;
        let zmax = -Infinity;
        for (const q of pts) {
            if (q[2] < zmin) zmin = q[2];
            if (q[2] > zmax) zmax = q[2];
        }
        const span = Math.max(1e-6, zmax - zmin);
        const norm = (z) => (z - zmin) / span;

        if (geo.groups) {
            const out = new Array(pts.length);
            for (const g of geo.groups) {
                let zc = 0;
                for (const i of g) zc += pts[i][2];
                zc /= g.length;
                const col = palette(norm(zc));
                for (const i of g) out[i] = col;
            }
            return out;
        }
        return pts.map((q) => palette(norm(q[2])));
    }

    /** 形状的外接尺度，用来定坐标轴长度 */
    #extent(geo) {
        let m = 0;
        for (const q of geo.points) {
            const d = Math.hypot(q[0], q[1], q[2]);
            if (d > m) m = d;
        }
        return Math.max(0.5, m);
    }

    // ── 几何 ──────────────────────────────────────

    /**
     * @returns {{points: number[][], rows?: number, cols?: number,
     *            listMode?: boolean, groups?: number[][]}}
     */
    #geometry() {
        const p = this.params;
        const n = Math.max(6, Math.round(p.detail));
        switch (this.preset.shape) {
            case 'torus': return this.#torus(n);
            case 'mobius': return this.#mobius(n);
            case 'icosa': return this.#icosahedron(p.radius);
            default: return this.#sphere(n);
        }
    }

    /** 球面：极角 u ∈ [0, π] 切 n 段，方位角 v ∈ [0, 2π] 也切 n 段（首尾重合以闭合） */
    #sphere(n) {
        const R = this.params.radius;
        const rows = n + 1;
        const cols = n + 1;
        const pts = [];
        for (let i = 0; i < rows; i++) {
            const u = (Math.PI * i) / n;
            const su = Math.sin(u);
            const cu = Math.cos(u);
            for (let j = 0; j < cols; j++) {
                const v = (2 * Math.PI * j) / n;
                pts.push([R * su * Math.cos(v), R * su * Math.sin(v), R * cu]);
            }
        }
        return { points: pts, rows, cols };
    }

    /** 环面：大圆 n 段、管圈 m 段，两个方向都闭合 */
    #torus(n) {
        const R = Math.max(0.4, this.params.radius);
        const r = Math.min(this.params.tube, R * 0.9);
        const rows = n + 1;
        const m = Math.max(6, Math.round(n / 2));
        const cols = m + 1;
        const pts = [];
        for (let i = 0; i < rows; i++) {
            const u = (2 * Math.PI * i) / n;
            const cu = Math.cos(u);
            const su = Math.sin(u);
            for (let j = 0; j < cols; j++) {
                const v = (2 * Math.PI * j) / m;
                const rr = R + r * Math.cos(v);
                pts.push([rr * cu, rr * su, r * Math.sin(v)]);
            }
        }
        return { points: pts, rows, cols };
    }

    /**
     * 莫比乌斯带。
     *
     * 沿 u 走一圈回到起点时，带子翻了个面 —— 参数上就是 v → −v。
     * 一张规整点阵没法表达这件事，但可以让**最后一行**等于第一行倒过来，
     * 于是接缝那圈方格照常连上，带子真正闭合。
     * （若直接把最后一行写成第一行的正序，接缝会错位成一条裂缝。）
     */
    #mobius(n) {
        const p = this.params;
        const R = Math.max(0.3, p.radius);
        const halfW = p.width / 2;
        const k = Math.max(1, Math.round(p.twists));      // 半扭转数，奇数才闭合
        const rows = n + 1;
        const cols = Math.max(3, Math.round(n / 3)) + 1;
        const m = cols - 1;

        const halfAngle = (k * Math.PI) / 2;              // 走满 2π 时半角转过 k·π
        const at = (i, j) => {
            const u = (2 * Math.PI * i) / n;
            const v = (2 * j) / m - 1;                     // v ∈ [−1, 1]
            const a = halfAngle * (u / Math.PI);
            const rr = R + v * halfW * Math.cos(a);
            return [rr * Math.cos(u), rr * Math.sin(u), v * halfW * Math.sin(a)];
        };

        const pts = [];
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < cols; j++) pts.push(at(i, j));
        }
        // 最后一行 = 第一行倒序（v → −v），接缝于是严丝合缝
        for (let j = 0; j < cols; j++) pts.push(pts[(cols - 1) - j]);
        return { points: pts, rows, cols };
    }

    /** 正二十面体：交给 surface_mesh.wgsl 的「裸三角面列表」分支，天然平面着色 */
    #icosahedron(R) {
        const g = (1 + Math.sqrt(5)) / 2;
        const raw = [
            [0, 1, g], [0, 1, -g], [0, -1, g], [0, -1, -g],
            [1, g, 0], [1, -g, 0], [-1, g, 0], [-1, -g, 0],
            [g, 0, 1], [g, 0, -1], [-g, 0, 1], [-g, 0, -1],
        ];
        const verts = raw.map((v) => {
            const l = Math.hypot(v[0], v[1], v[2]);
            return [(v[0] / l) * R, (v[1] / l) * R, (v[2] / l) * R];
        });
        // 面表程序化生成：三条边都是「最短边」的三角形恰为 20 个。
        // 【不能硬编码面表】标准面表必须与顶点表的排列顺序配套，二者任一
        // 对不上，就会连成「大二十面体」（面跨到次近邻顶点，边长 ×φ，
        // 一半绕向朝内）——渲染出来是一团自交的星形。程序化生成对任何
        // 顶点排列都成立，且绕向自动统一朝外。
        const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        let edge = Infinity;
        for (let i = 0; i < 12; i++) {
            for (let j = i + 1; j < 12; j++) edge = Math.min(edge, dist3(verts[i], verts[j]));
        }
        const isEdge = (i, j) => dist3(verts[i], verts[j]) < edge * 1.01;
        const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        const cross3 = (a, b) => [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ];
        const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const faces = [];
        for (let i = 0; i < 12; i++) {
            for (let j = i + 1; j < 12; j++) {
                if (!isEdge(i, j)) continue;
                for (let k = j + 1; k < 12; k++) {
                    if (!isEdge(j, k) || !isEdge(i, k)) continue;
                    const f = [i, j, k];
                    const [a, b, c] = f.map((x) => verts[x]);
                    const n = cross3(sub3(b, a), sub3(c, a));
                    const cen = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
                    if (dot3(n, cen) < 0) f.reverse();   // 统一绕向：法线朝外
                    faces.push(f);
                }
            }
        }
        if (faces.length !== 20) throw new Error(`二十面体建面异常：${faces.length} 个面（应为 20）`);
        const points = [];
        const groups = [];
        for (const f of faces) {
            const idx = [];
            for (const k of f) {
                idx.push(points.length);
                points.push(verts[k]);
            }
            groups.push(idx);
        }
        return { points, listMode: true, groups };
    }

    // ── 相机与交互 ────────────────────────────────

    applyCamera() {
        const cam = this.gpu.camera;
        cam.reset();
        cam.perspective = true;      // 有限焦距 -> project_point 里的 w 开始随深度变化
        cam.center = [0, 0, 0];
        this.theta = this.preset.view.theta;
        this.phi = this.preset.view.phi;
        this.zoom = this.preset.view.zoom;
        this.#syncCamera();
    }

    #syncCamera() {
        const cam = this.gpu.camera;
        cam.center = [0, 0, 0];
        cam.theta = this.theta;
        cam.phi = this.phi;
        cam.zoom = this.zoom;
    }

    /** 拖拽转动物体 / 滚轮推近拉远 / 双击回到预设视角 */
    handleCanvasEvent(e) {
        if (e.type === 'pan') {
            this.theta += e.dx * ROT_PER_PX;
            this.phi = Math.max(-PHI_LIMIT, Math.min(PHI_LIMIT, this.phi - e.dy * ROT_PER_PX));
            this.#syncCamera();
        } else if (e.type === 'zoom') {
            const k = Math.min(1.6, Math.max(0.6, 1 - e.delta));
            this.zoom = Math.max(0.45, Math.min(3, this.zoom * k));
            this.#syncCamera();
        } else if (e.type === 'reset') {
            this.theta = this.preset.view.theta;
            this.phi = this.preset.view.phi;
            this.zoom = this.preset.view.zoom;
            this.#syncCamera();
        }
    }

    /** 播放：匀速自转，看曲面的侧面 */
    playStep() {
        const rate = Math.max(0.08, this.params.spinRate);
        this.theta += 0.012 * rate;
        this.#syncCamera();
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
const shapeIs = (...shapes) => (p, inst) => shapes.includes(inst?.preset?.shape);
const gridOnly = (p, inst) => !inst?.preset || inst.preset.shape !== 'icosa';

const PANEL = [
    { type: 'section', labelKey: 'section.shape' },
    {
        type: 'slider', key: 'detail', labelKey: 'ctrl.detail',
        min: 8, max: 80, step: 1, format: (v) => String(Math.round(v)),
        visible: gridOnly,
    },
    {
        type: 'slider', key: 'radius', labelKey: 'ctrl.radius',
        min: 0.6, max: 3, step: 0.05, format: (v) => v.toFixed(2),
    },
    {
        type: 'slider', key: 'tube', labelKey: 'ctrl.tube',
        min: 0.15, max: 1.2, step: 0.05, format: (v) => v.toFixed(2),
        visible: shapeIs('torus'),
    },
    {
        type: 'slider', key: 'width', labelKey: 'ctrl.width',
        min: 0.4, max: 2.6, step: 0.05, format: (v) => v.toFixed(2),
        visible: shapeIs('mobius'),
    },
    {
        type: 'slider', key: 'twists', labelKey: 'ctrl.twists',
        min: 1, max: 3, step: 1, format: (v) => String(Math.round(v)),
        visible: shapeIs('mobius'),
    },
    { type: 'section', labelKey: 'section.material' },
    {
        type: 'slider', key: 'reflect', labelKey: 'ctrl.reflect',
        min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2),
    },
    {
        type: 'slider', key: 'gloss', labelKey: 'ctrl.gloss',
        min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2),
    },
    {
        type: 'slider', key: 'shadow', labelKey: 'ctrl.shadow',
        min: 0, max: 1, step: 0.02, format: (v) => v.toFixed(2),
    },
    { type: 'section', labelKey: 'section.display' },
    { type: 'check', key: 'showAxes', labelKey: 'ctrl.showAxes' },
    { type: 'check', key: 'wireframe', labelKey: 'ctrl.wireframe', visible: gridOnly },
    { type: 'section', labelKey: 'section.view' },
    {
        type: 'slider', key: 'spinRate', labelKey: 'ctrl.spinRate',
        min: 0, max: 3, step: 0.05, format: (v) => v.toFixed(2),
    },
];

/** 模块描述符 —— 注册进 registry.js 即出现在侧栏 */
export const solidModule = {
    id: 'solid',
    nameKey: 'module.solid',
    presets: PRESETS,
    panel: PANEL,
    create: (gpu) => new SolidModule(gpu),
};
