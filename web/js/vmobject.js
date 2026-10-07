/**
 * VMobject 数据系统 —— 移植自 3b1b/manim 的 vectorized_mobject 数据布局
 *
 * 上游把一条曲线拆成「二次贝塞尔」串：每段三个记录（锚点、控制柄、锚点），
 * 相邻段共享锚点，所以第 n 段从记录 2n 开始（stroke.wgsl / fill.wgsl 的注释
 * 都写明了 RECORD_STEP = 2）。控制柄取两端锚点的中点时，二次贝塞尔退化为
 * 直线段 —— 这正是上游 set_points_as_corners 的做法，采样足够密时足以
 * 表现任意函数曲线。
 *
 * 记录布局（自行定义，与上游语义一致；着色器只按名字取字段）：
 *   point(3)  subpath_range(2)  stroke_width(1)  stroke_rgba(4)   → 12 float
 *
 * subpath_range 语义（见 stroke.wgsl 的 neighbor_tangent / fill.wgsl 的 base_point）：
 *   对子路径 [s, e] 中的记录 r，存 [r - s, e - r]，
 *   即「子路径起点在本记录之前多远 / 终点在本记录之后多远」。
 *   开放子路径首尾点不同 → 着色器判为不闭合，端点用平头帽。
 *
 * 【两条硬约束，见 buildStrokeRecords 的注释】每个子路径占偶数条记录（末尾补一条
 * 分隔记录，相邻子路径之间除外），全对象记录总数为奇数。
 *   一个 n 锚点的子路径 → 2n−1 条记录 → n−1 段曲线；
 *   曲线数 = 记录总数 // 2（含子路径接缝处的空曲线）。
 *
 * 上游对应文件：manimlib/mobject/types/vectorized_mobject.py
 *   （start_new_path / set_subpath_range / get_subpath_end_indices_from_points）
 */

/** 顶点记录布局：每条记录 12 个 float（48 字节） */
export const VM_STROKE_RECORD = {
    itemsize: 48,
    fields: {
        point: 0,           // vec3f 锚点/控制柄
        subpath_range: 12,  // vec2f
        stroke_width: 20,   // f32
        stroke_rgba: 24,    // vec4f
    },
};

/**
 * VMobject 的整对象 uniform。
 * 字段清单由 stroke.wgsl / fill.wgsl / project_point.wgsl / fill_color.wgsl /
 * finalize_color.wgsl 实际引用的 mob.* 汇总而来，一个都不能少，否则编译报错。
 */
export const VM_OBJECT_FIELDS = [
    { name: 'is_fixed_in_frame', type: 'f32' },
    { name: 'clip_plane0', type: 'vec4f' },
    { name: 'clip_plane1', type: 'vec4f' },
    { name: 'clip_plane2', type: 'vec4f' },
    { name: 'clip_plane3', type: 'vec4f' },
    { name: 'shading', type: 'vec3f' },
    { name: 'joint_roundness', type: 'f32' },
    { name: 'flat_stroke', type: 'f32' },
    { name: 'stroke_width_in_scene_units', type: 'f32' },
    { name: 'anti_alias_width', type: 'f32' },
    { name: 'fill_border_width', type: 'f32' },
    { name: 'fill_rgba', type: 'vec4f' },
    { name: 'fill_rgba_end', type: 'vec4f' },
    { name: 'gradient_start', type: 'vec3f' },
    { name: 'gradient_end', type: 'vec3f' },
    { name: 'unit_normal', type: 'vec3f' },
];

const STRIDE = VM_STROKE_RECORD.itemsize / 4;

/** 上游 stroke.wgsl：每段曲线固定占 6 * (MAX_STEPS - 1) = 186 个顶点 */
export const VERTS_PER_STROKE_CURVE = 186;

/**
 * 上游 fill.wgsl：每段曲线贡献两个三角形（一个扇向子路径起点、一个贴着曲线），
 * 共 6 个顶点。填充要按 **曲线数** 算顶点数，而不是 anchor 数。
 */
export const VERTS_PER_FILL_CURVE = 6;

/**
 * 顶点数 = 曲线数 × 每段顶点数 的换算。
 * 填充的三趟与描边各自用不同的常数，混用会画出半个图形，故集中在这里。
 */
export function vertexCount(curveCount, perCurve) {
    return curveCount * perCurve;
}

function asVec3(p) {
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

/**
 * 把「锚点序列 + 样式」写成记录。
 *
 * 【两条硬约束，破坏任何一条整幅图形都会错位】
 *   1. 第 c 段曲线固定在记录 2c 上（stroke.wgsl / fill.wgsl 的 RECORD_STEP = 2），
 *      所以每个子路径必须占用**偶数**条记录，下一段子路径才能从偶数号开始。
 *      一个 n 锚点的子路径占 2n−1 条（奇数），故除最后一段外都要再补一条
 *      **分隔记录**（重复本子路径的最后一条）。上游管它叫"空曲线"，
 *      见 vectorized_mobject.py 的 start_new_path / get_subpath_end_indices。
 *   2. 记录总数必须是**奇数**：着色器按 records // 2 算曲线数，
 *      偶数会多算出一段越界的曲线。
 *      补上分隔记录后总数 = 2Σnᵢ − 1，恰好是奇数。
 *
 * 分隔记录自身构成一段 controls[0] == controls[1] 的"空曲线"，
 * 两个着色器都会把它塌成一个点，不画任何东西。
 *
 * @param {Array<{anchors: number[][], width: number|number[], rgba: number[]|number[][]}>} subpaths
 *        每个子路径一组锚点；闭合形状（如矩形）把首点重复一遍作为最后一个锚点
 * @returns {{data: Float32Array, curveCount: number, recordCount: number}}
 */
export function buildStrokeRecords(subpaths) {
    const parts = (subpaths ?? []).filter((sp) => (sp.anchors?.length ?? 0) >= 2);

    let recordCount = 0;
    parts.forEach((sp, i) => {
        recordCount += 2 * sp.anchors.length - 1;
        if (i < parts.length - 1) recordCount += 1;   // 分隔记录
    });

    const data = new Float32Array(recordCount * STRIDE);
    let r = 0;

    parts.forEach((sp, index) => {
        const anchors = sp.anchors;
        const n = anchors.length;
        const s = r;
        const e = r + (2 * n - 2);

        for (let i = 0; i < n; i++) {
            writeRecord(data, r, anchors[i], widthAt(sp.width, i), rgbaAt(sp.rgba, i), r - s, e - r);
            if (i < n - 1) {
                // 控制柄取中点 → 二次贝塞尔退化为直线段（上游 set_points_as_corners）
                const a = asVec3(anchors[i]);
                const b = asVec3(anchors[i + 1]);
                writeRecord(
                    data, r + 1,
                    [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
                    widthAt(sp.width, i), rgbaAt(sp.rgba, i),
                    (r + 1) - s, e - (r + 1),
                );
                r += 2;
            } else {
                r += 1;
            }
        }

        if (index < parts.length - 1) {
            // subpath_range 存 (距本子路径起点 +1, −1)，与上游 set_subpath_range 一致：
            // 它在 end+2 处也写一份，那条记录就是这里的这一条。
            writeRecord(data, r, anchors[n - 1], 0, [0, 0, 0, 0], r - s, -1);
            r += 1;
        }
    });

    return { data, curveCount: recordCount >> 1, recordCount };
}

function widthAt(w, i) {
    return Array.isArray(w) ? (w[i] ?? 0) : (w ?? 0);
}

function rgbaAt(c, i) {
    if (Array.isArray(c) && typeof c[0] === 'number') return c; // 单个 rgba
    return c[i] ?? [0, 0, 0, 0];
}

function writeRecord(data, index, point, width, rgba, subStart, subEnd) {
    const base = index * STRIDE;
    data[base + 0] = point[0] ?? 0;
    data[base + 1] = point[1] ?? 0;
    data[base + 2] = point[2] ?? 0;
    data[base + 3] = subStart;
    data[base + 4] = subEnd;
    data[base + 5] = width;
    data[base + 6] = rgba[0] ?? 0;
    data[base + 7] = rgba[1] ?? 0;
    data[base + 8] = rgba[2] ?? 0;
    data[base + 9] = rgba[3] ?? 1;
    // base+10, base+11 留空（对齐用）
}

// ─────────────────────────────────────────────────────────────
// 曲面（Surface）——移植自 mobject/types/surface.py
//
// 上游不给曲面传三角面索引，而是**交一张点阵**：resolution.x 行 × resolution.y 列，
// 网格由 surface_mesh.wgsl 在顶点着色器里现推 —— 每格拆两个三角形，
// 每个顶点问「我是哪一格的哪个角」。法线也是从相邻点的差分现叉出来的，
// 所以球极点那种「一列退化成一点」的网格会自动改用旁边的列。
//
// 因此本项目这一侧只需要按行优先把点阵与颜色铺平即可，没有任何拓扑要维护。
//   记录布局：point(3) rgba(4) → 7 个 float / 28 字节
// ─────────────────────────────────────────────────────────────

/** 曲面记录布局：每格点 7 个 float（28 字节） */
export const VM_SURFACE_RECORD = {
    itemsize: 28,
    fields: {
        point: 0,   // vec3f
        rgba: 12,   // vec4f
    },
};

/**
 * 曲面用到的 uniform：比描边那套少了填充相关字段，多出 resolution。
 * （surface.wgsl 只引用 is_fixed_in_frame / clip_plane* / shading / resolution）
 */
export const VM_SURFACE_FIELDS = [
    { name: 'is_fixed_in_frame', type: 'f32' },
    { name: 'clip_plane0', type: 'vec4f' },
    { name: 'clip_plane1', type: 'vec4f' },
    { name: 'clip_plane2', type: 'vec4f' },
    { name: 'clip_plane3', type: 'vec4f' },
    { name: 'shading', type: 'vec3f' },
    { name: 'resolution', type: 'vec2f' },
];

/** surface_mesh.wgsl：每个网格方块出 6 个顶点（两个三角形） */
export const VERTS_PER_SURFACE_SQUARE = 6;

/**
 * 把一张点阵写成曲面记录。
 *
 * @param {Array<[number,number,number]>} points 行优先的点阵（rows × cols）
 * @param {Array<number[]>|number[]} colors 与 points 等长的颜色；单个 rgba 表示整面同色
 * @returns {{data: Float32Array, count: number, resolution: [number, number]}}
 */
export function buildSurfaceRecords(points, colors) {
    const count = points?.length ?? 0;
    const data = new Float32Array(count * (VM_SURFACE_RECORD.itemsize / 4));
    const uniformColor = Array.isArray(colors) && typeof colors[0] === 'number' ? colors : null;

    for (let i = 0; i < count; i++) {
        const p = asVec3(points[i]);
        const base = i * 7;
        data[base + 0] = p[0];
        data[base + 1] = p[1];
        data[base + 2] = p[2];
        const rgba = uniformColor ?? colors?.[i] ?? [1, 1, 1, 1];
        data[base + 3] = rgba[0] ?? 0;
        data[base + 4] = rgba[1] ?? 0;
        data[base + 5] = rgba[2] ?? 0;
        data[base + 6] = rgba[3] ?? 1;
    }
    return { data, count, resolution: null };
}

/**
 * 曲面的整对象 uniform。
 * @param {object} mob 该图层的 uniform block
 * @param {[number, number]|null} resolution [行, 列]；传 null 表示记录是**裸三角面列表**
 *        （surface_mesh.wgsl 的 resolution.x == 0 分支，三个记录一个三角形）
 * @param {number[]} [shading] [反光, 高光, 阴影] 三项，全 0 = 不做光照
 */
export function setSurfaceDefaults(mob, resolution, shading = [0.7, 0.35, 0.5]) {
    mob.setFloats('is_fixed_in_frame', 0);
    mob.setFloats('clip_plane0', [0, 0, 0, 0]);
    mob.setFloats('clip_plane1', [0, 0, 0, 0]);
    mob.setFloats('clip_plane2', [0, 0, 0, 0]);
    mob.setFloats('clip_plane3', [0, 0, 0, 0]);
    mob.setFloats('shading', shading);
    mob.setFloats('resolution', resolution ?? [0, 0]);
    return mob;
}

/** 一组 VMobject 通用 uniform 值（2D 平面描边场景的默认值） */
export function setVMObjectDefaults(mob) {
    mob.setFloats('is_fixed_in_frame', 1);
    mob.setFloats('clip_plane0', [0, 0, 0, 0]);
    mob.setFloats('clip_plane1', [0, 0, 0, 0]);
    mob.setFloats('clip_plane2', [0, 0, 0, 0]);
    mob.setFloats('clip_plane3', [0, 0, 0, 0]);
    // 全零 shading = 不做光照（见 finalize_color.wgsl 的 add_light）
    mob.setFloats('shading', [0, 0, 0]);
    // 1 = 接头完全圆润，避免折线急转处出现尖刺
    mob.setFloats('joint_roundness', 1);
    mob.setFloats('flat_stroke', 1);
    mob.setFloats('stroke_width_in_scene_units', 0);
    mob.setFloats('anti_alias_width', 1.0);
    mob.setFloats('fill_border_width', 0);
    mob.setFloats('fill_rgba', [0, 0, 0, 0]);
    mob.setFloats('fill_rgba_end', [0, 0, 0, 0]);
    mob.setFloats('gradient_start', [0, 0, 0]);
    mob.setFloats('gradient_end', [0, 0, 0]);
    mob.setFloats('unit_normal', [0, 0, 1]);
    return mob;
}

/**
 * 打开一个图层的填充。
 *
 * 填充色是**整块 uniform** 上的一个值，也就是说一层里所有子路径共用一个颜色 ——
 * 这正是上游"一个 mobject 一次填充"的做法（drawing.py: 一次填充只覆盖一个 mobject）。
 * 想画两种颜色就分两层。
 *
 * @param {object} mob  该图层的 uniform block
 * @param {number[]} rgba 填充色（alpha 为 0 时该层什么也不画）
 * @param {number[]} [rgbaEnd] 渐变终点色，默认与 rgba 相同（即纯色）
 * @param {number} [borderWidth] 沿路径描的那圈边框的宽度，0 = 只留够抗锯齿的窄带
 */
export function setVMObjectFill(mob, rgba, rgbaEnd = rgba, borderWidth = 0) {
    mob.setFloats('fill_rgba', rgba);
    mob.setFloats('fill_rgba_end', rgbaEnd);
    mob.setFloats('fill_border_width', borderWidth);
    return mob;
}

/** 该颜色是否有填充（alpha 为 0 时上游会整条跳过填充的三趟） */
export function hasFill(rgba) {
    return Array.isArray(rgba) && (rgba[3] ?? 0) > 0;
}
