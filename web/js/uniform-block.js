/**
 * Uniform 布局 —— 移植自 3b1b/manim 的 manimlib/renderer/uniform_block.py
 *
 * 【踩坑要点，务必先读】
 * WGSL 的 uniform block 遵循 std140 风格的对齐规则，这是本项目实测中最大的坑：
 *   1. vec3f 占用 16 字节，但只有 12 字节有效数据 —— 后面必须补一个 f32 占位
 *   2. 数组元素（如 array<vec4f, 9>）每项按 16 字节对齐
 *   3. 结构体总大小必须是 16 的倍数
 * 违反任何一条都会报 "buffer binding is too small" 或静默读到错位数据。
 * 上游 manim 用 numpy 的 structured dtype 描述布局，本模块用等价的描述子。
 */

/** 标量/向量类型 -> { 对齐字节数, 占用字节数 } */
const TYPE_INFO = {
    f32: { align: 4, size: 4 },
    i32: { align: 4, size: 4 },
    u32: { align: 4, size: 4 },
    f16: { align: 2, size: 2 },
    vec2f: { align: 8, size: 8 },
    vec3f: { align: 16, size: 12 },
    vec4f: { align: 16, size: 16 },
    vec2i: { align: 8, size: 8 },
    vec3i: { align: 16, size: 12 },
    vec4i: { align: 16, size: 16 },
    mat4x4f: { align: 16, size: 64 },
    mat3x3f: { align: 16, size: 48 },
};

function align(value, boundary) {
    return Math.ceil(value / boundary) * boundary;
}

/** 真正的类数组判断：涵盖 Float32Array、Array、arguments 等。 */
function isArrayLike(v) {
    return v != null && typeof v !== 'number' && typeof v.length === 'number';
}

/**
 * 由字段描述表算出 uniform 布局。
 *
 * 规则（已对照上游 manim 的 frame_uniforms.wgsl 验证）：
 *   - 每个成员按自身对齐要求放置
 *   - vec3f 占 12 字节但对齐到 16；紧跟其后的 f32 会填进这12 字节之后的
 *     4 字节空隙，此时不需要额外插入占位字段
 *   - 数组每项按 16 字节对齐
 *   - struct 总大小补齐到 16 的倍数
 */
export function computeLayout(fields) {
    let offset = 0;
    const offsets = {};
    const stride = {};

    for (const f of fields) {
        const info = TYPE_INFO[f.type];
        if (!info) throw new Error(`未知的 uniform 类型：${f.type}`);
        const count = f.count ?? 1;

        if (count > 1) {
            // 数组：元素间距按 16 对齐
            const itemStride = align(info.size, 16);
            offset = align(offset, 16);
            offsets[f.name] = offset;
            stride[f.name] = itemStride;
            offset += itemStride * count;
        } else {
            offset = align(offset, info.align);
            offsets[f.name] = offset;
            stride[f.name] = info.size;
            // vec3f 只推进 12 字节。若下一个字段需要 16 对齐，
            // 上面的 align() 会自动补上那 4 字节。
            offset += info.size;
        }
    }

    const size = align(offset, 16);
    return { size, offsets, stride };
}

/**
 * 生成 WGSL 的 struct 成员声明。
 *
 * 【重要】只声明真实字段，不插入任何 _pad 填充。
 * WGSL 编译器会依据自身规则自动对齐，CPU 侧 computeLayout 已复现同样的
 * 规则，二者必然一致。若手动加填充字段，反而容易与编译器算出的偏移错位
 * （例如 array<vec4f,1> 自身也要 16 字节对齐，占 16 而非 4）。
 */
function buildDecl(fields) {
    const lines = [];
    for (const f of fields) {
        const count = f.count ?? 1;
        const type = count > 1 ? `array<${f.type}, ${count}>` : f.type;
        lines.push(`    ${f.name}: ${type},`);
    }
    return { decl: lines.join('\n'), size: computeLayout(fields).size };
}

/**
 * 一个可写入 GPU 的 uniform 块。
 * 用法：const u = new UniformBlock(fields); u.setFloats('opacity', 1); u.upload(device, buffer);
 */
export class UniformBlock {
    constructor(fields) {
        this.fields = fields;
        const layout = computeLayout(fields);
        const decl = buildDecl(fields);
        this.size = decl.size;
        this.offsets = layout.offsets;
        this.arrayStride = layout.stride;
        this.decl = decl.decl;
        this.data = new ArrayBuffer(this.size);
        this.f32 = new Float32Array(this.data);
        this.i32 = new Int32Array(this.data);
        this.u32 = new Uint32Array(this.data);
    }

    /** 以 float 写入标量或向量分量。 */
    setFloats(name, values) {
        const off = this.offsets[name];
        if (off === undefined) throw new Error(`未知 uniform 字段：${name}`);
        // 注意：必须用 isArrayLike 判断。Float32Array 等类型化数组不是 Array 的实例，
        // 若只用 Array.isArray，会把整个数组当成单个值写入，最终得到 NaN，
        // 导致相机矩阵失效、整个 quad 塌缩成一个点。
        const arr = isArrayLike(values) ? values : [values];
        const base = off / 4;
        for (let i = 0; i < arr.length; i++) this.f32[base + i] = arr[i];
        return this;
    }

    /** 写入数组（如 colors）。 */
    setArray(name, values, itemSize = 4) {
        const off = this.offsets[name];
        if (off === undefined) throw new Error(`未知 uniform 数组：${name}`);
        const stride = this.arrayStride[name] / 4;
        const base = off / 4;
        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            for (let k = 0; k < itemSize; k++) {
                this.f32[base + i * stride + k] = isArrayLike(v) ? v[k] : v;
            }
        }
        return this;
    }

    /** 上传到 GPU buffer。 */
    upload(device, buffer) {
        device.queue.writeBuffer(buffer, 0, this.data);
        return this;
    }

    createBuffer(device) {
        return device.createBuffer({
            size: this.size,
            // COPY_SRC 便于调试时读回，确认 uniform 真的送到了 GPU
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
    }
}

/**
 * 帧级 uniform —— 严格对齐上游 renderer/gpu.py 的 FRAME_UNIFORMS：
 *   view(16) frame_rescale_factors(3) frame_scale(1)
 *   camera_position(3) pixel_size(1) light_position(3)
 */
export const FRAME_FIELDS = [
    { name: 'view', type: 'mat4x4f' },
    { name: 'frame_rescale_factors', type: 'vec3f' },
    { name: 'frame_scale', type: 'f32' },
    { name: 'camera_position', type: 'vec3f' },
    { name: 'pixel_size', type: 'f32' },
    { name: 'light_position', type: 'vec3f' },
];

/** 着色器里 frame_uniforms.wgsl 对应的 struct，供#INSERT 片段使用。 */
export const FRAME_STRUCT = `struct FrameUniforms {
    view: mat4x4f,
    frame_rescale_factors: vec3f,
    frame_scale: f32,
    camera_position: vec3f,
    pixel_size: f32,
    light_position: vec3f,
}
@group(0) @binding(0) var<uniform> frame: FrameUniforms;`;

/**
 * 构造一个 mobject uniform 块：生成与 WGSL 布局一致的 struct 声明。
 * @param {Array} fields 字段描述表
 * @param {number} bindingIndex bind group 序号（上游 mobject 用 1）
 */
export function makeMobjectBlock(fields, bindingIndex = 1) {
    const block = new UniformBlock(fields);
    const structName = 'MobjectUniforms';
    block.source = `struct ${structName} {
${block.decl}
}
@group(${bindingIndex}) @binding(0) var<uniform> mob: ${structName};`;
    return block;
}
