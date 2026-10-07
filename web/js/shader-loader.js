/**
 * 着色器加载器 —— 移植自 3b1b/manim 的 manimlib/renderer/shader_source.py
 *
 * 上游 manim 用一个模板机制组织 WGSL：
 *   1. #INSERT xxx.wgsl        把片段文件内容就地展开
 *   2. // DATA_LAYOUT          注入顶点记录的字段偏移常量
 *   3. // MOBJECT_UNIFORMS     注入本类 mobject 的 uniform 成员声明
 *   4. // TEXTURES             注入纹理绑定声明
 *
 * 这样同一份着色器源码能服务不同类型的 mobject，无需改写文件本身。
 * 本模块在浏览器端复刻这套机制，从而让上游 .wgsl 文件零改写直接使用。
 */

const SHADER_BASE = '/shaders/';
const INSERT_BASE = '/shaders/inserts/';

import { FRAME_STRUCT } from './uniform-block.js';

/**
 * 虚拟片段：这些文件在磁盘上并不存在，而是按被绘制对象动态生成的。
 *
 * 上游 inserts/NOTE.md 说明了三条注释形式的替换（而非 #INSERT）：
 *   // MOBJECT_UNIFORMS  本对象 uniform 块的成员声明
 *   // DATA_LAYOUT顶点记录的字段偏移
 *   // TEXTURES          纹理绑定
 * 其中 mobject_uniforms.wgsl 虽然写成 #INSERT 的样子，但它内部携带
 * // MOBJECT_UNIFORMS 占位符，必须由调用方按当前对象类型生成。
 * 这正是上游 uniform_block_code() 的职责。
 */
const VIRTUAL = new Set(['mobject_uniforms.wgsl', 'frame_uniforms.wgsl']);

/** 已加载的着色器源码缓存，避免重复取。 */
const sourceCache = new Map();

async function fetchSource(path) {
    if (sourceCache.has(path)) return sourceCache.get(path);
    const res = await fetch(path);
    if (!res.ok) throw new Error(`着色器加载失败 ${path}: ${res.status}`);
    const text = await res.text();
    sourceCache.set(path, text);
    return text;
}

/**
 * 把一个 #INSERT 指令替换为目标文件内容。
 * manim 的规则是「每个指令只替换一次」，所以用 replace 而非 replaceAll。
 */
function expandInserts(code, insertNames, cache) {
    let out = code;
    for (const name of insertNames) {
        const directive = `#INSERT ${name}`;
        if (!out.includes(directive)) continue;
        const body = cache.get(name);
        if (body === undefined) {
            throw new Error(`着色器引用了未提供的片段：${name}`);
        }
        out = out.replace(directive, body);
    }
    return out;
}

/**
 * 扫描源码里的所有 #INSERT 指令，按依赖顺序做递归展开。
 *
 * 上游 manim 在 Python 侧是逐文件读取后替换，本项目改为浏览器端递归拉取，
 * 语义一致：被插入的片段自身也可能再 #INSERT 别的片段（如 project_point 插入
 * frame_units），所以必须递归而非单趟替换。
 */
async function resolveInserts(code, virtual = {}, onProgress = null) {
    const cache = new Map();
    const visiting = new Set();

    const loadFragment = async (name) => {
        if (cache.has(name)) return cache.get(name);
        if (visiting.has(name)) {
            throw new Error(`着色器片段循环引用：${name}`);
        }
        visiting.add(name);

        let body;
        if (virtual[name] !== undefined) {
            body = virtual[name];
        } else if (VIRTUAL.has(name)) {
            throw new Error(`着色器需要虚拟片段 ${name}，但调用方未提供`);
        } else {
            body = await fetchSource(INSERT_BASE + name);
        }

        // 片段自身可能还有 #INSERT，递归展开。
        // 注意 resolveInserts 返回 {expanded, fragments}，这里必须取 .expanded，
        // 否则会把整个对象当字符串插入，产出 "[object Object]"。
        if (body.includes('#INSERT')) {
            body = (await resolveInserts(body, virtual, onProgress)).expanded;
        }
        visiting.delete(name);
        cache.set(name, body);
        return body;
    };

    const names = [...code.matchAll(/#INSERT\s+([\w./-]+\.wgsl)/g)].map((m) => m[1]);
    for (const n of names) await loadFragment(n);
    onProgress?.(`展开 ${names.length} 个片段`);

    return { expanded: expandInserts(code, names, cache), fragments: cache };
}

/** 注入顶点记录的布局常量（对照上游 data_layout_code）。 */
function injectDataLayout(code, dtype) {
    const stride = dtype.itemsize / 4;
    const lines = [`const DATA_STRIDE: u32 = ${stride}u;`];
    for (const [name, offset] of Object.entries(dtype.fields)) {
        lines.push(`const DATA_OFFSET_${name}: u32 = ${offset / 4}u;`);
    }
    return code.replace('// DATA_LAYOUT', lines.join('\n'));
}

/** 注入本 mobject 的 uniform 成员声明（对照上游 uniform_block_code）。 */
function injectMobjectUniforms(code, members) {
    return code.replace('// MOBJECT_UNIFORMS', members);
}

/** 注入纹理绑定声明（对照上游 texture_binding_code）。无纹理时留空。 */
function injectTextures(code, decls) {
    return code.replace('// TEXTURES', decls ?? '');
}

/**
 * 源码级替换（对照上游 Material.get_code 的 re.sub 循环）。
 *
 * 一份着色器源码编译出多个模块，靠的就是这个：填充的边框并不是另一个文件，
 * 而是把 stroke.wgsl 里那一行
 *     const IS_FILL_BORDER: bool = false;
 * 换成 true 后再编译一遍，于是同一套描边代码改成"取填充的颜色与宽度"。
 * 找不到待替换的片段就直接报错 —— 上游也这么干，静默失败会让边框整条消失。
 */
function applyReplacements(code, replace) {
    let out = code;
    for (const [from, to] of Object.entries(replace)) {
        if (!out.includes(from)) {
            throw new Error(`着色器源码里找不到待替换的片段：${from}`);
        }
        out = out.split(from).join(to);
    }
    return out;
}

/**
 * 组装出最终可编译的 WGSL 源码。
 *
 * 对应上游 get_shader_code()：读文件 → 展开 #INSERT → 填 data layout
 * → 填 uniform 成员 → 填纹理绑定。
 *
 * @param {string} filename shaders/ 下的着色器文件名
 * @param {object} options
 * @param {{itemsize:number, fields:Object}|null} options.dataLayout 顶点记录布局
 * @param {string} options.uniformMembers MobjectUniforms 的 struct 声明
 * @param {Record<string,string>} options.virtual 虚拟片段内容
 * @param {Record<string,string>} options.replace 源码级替换（如把 IS_FILL_BORDER 翻成 true）
 */
export async function buildShaderCode(filename, options = {}) {
    const {
        dataLayout = null,
        uniformMembers = '',
        virtual = {},
        textureDecls = '',
        replace = null,
        onProgress = null,
    } = options;

    const path = SHADER_BASE + filename;
    const raw = await fetchSource(path);
    onProgress?.(`读取 ${filename}`);

    // 虚拟片段：mobject_uniforms 携带 // MOBJECT_UNIFORMS 占位符，
    // frame_uniforms 内容固定（与上游 frame_uniforms.wgsl 一致）
    const virtualMap = {
        'mobject_uniforms.wgsl':
            `struct MobjectUniforms {\n// MOBJECT_UNIFORMS\n}\n` +
            `@group(1) @binding(0) var<uniform> mob: MobjectUniforms;`,
        'frame_uniforms.wgsl': FRAME_STRUCT,
        ...virtual,
    };

    const { expanded, fragments } = await resolveInserts(raw, virtualMap, onProgress);

    let code = expanded;
    if (dataLayout) code = injectDataLayout(code, dataLayout);
    code = injectMobjectUniforms(code, uniformMembers);
    code = injectTextures(code, textureDecls);
    // 替换放在最后：它作用于已经展开好的完整源码
    if (replace) code = applyReplacements(code, replace);
    onProgress?.(`展开 ${fragments.size} 个片段完成`);
    return code;
}

/** 预取一组着色器，让首帧不必等待网络。 */
export async function preloadShaders(filenames, onProgress) {
    for (const f of filenames) {
        try {
            await buildShaderCode(f, { onProgress });
        } catch (e) {
            onProgress?.(`预取失败 ${f}: ${e.message}`);
        }
    }
}
