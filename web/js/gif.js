/**
 * GIF 导出 —— 从零实现的 GIF89a 编码器（零第三方依赖）。
 *
 * 为什么不引一个现成的 GIF 库：
 *   本项目的硬约束是「纯本地、零依赖、不打包」。为了一个导出功能塞进一个
 *   几百 KB 的编码器，既违背约束，也没必要 —— GIF 的压缩算法（LZW）和
 *   容器格式（GIF89a）都是八十年代就冻结了的东西，自己写一遍反而更好控制。
 *
 * 一条 GIF 从像素到文件要经过三段：
 *   ① 量化  把几万种颜色压成 ≤256 色的调色板（中位切分 median cut）
 *   ② 索引  逐像素查表换成调色板下标，可选 Floyd–Steinberg 误差扩散抖动
 *   ③ 编码  LZW 压缩 + GIF89a 容器（逻辑屏幕 / 全局色表 / 循环扩展 / 每帧图像）
 *
 * ── 为什么 GIF 而不是继续录 WebM ──
 * WebM 是**实时**录的：录 5 秒就得播 5 秒，机器卡了帧率还会掉。
 * GIF 走的是**逐帧离屏渲染**：调一遍 playStep() 渲染一帧读回像素，
 * 想做 60 帧就调 60 次，快慢只取决于机器算力，与播放时长无关。
 * 代价是 GIF 只有 256 色 —— 所以它适合曲线、网格、分形这类
 * 「大片纯色 + 少数边缘」的数学画面，不适合照片。
 *
 * 用法：
 *   const blob = encodeGif(frames, width, height, { delayCs: 8 });
 */

/** 帧率上限保护：GIF 单文件帧数太多会又大又慢 */
export const MAX_GIF_FRAMES = 240;
/** 调色板颜色上限（GIF 规格） */
const MAX_COLORS = 256;
/** 量化时最多采样多少个像素（采样越多越准，但内存与时间线性上涨） */
const SAMPLE_BUDGET = 60000;

/** 可增长的字节缓冲（GIF 长度事先不知道，只能边写边长） */
class ByteWriter {
    constructor() {
        this.buf = new Uint8Array(1 << 16);
        this.len = 0;
    }

    #ensure(n) {
        if (this.len + n <= this.buf.length) return;
        let cap = this.buf.length;
        while (cap < this.len + n) cap *= 2;
        const next = new Uint8Array(cap);
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
    }

    byte(v) {
        this.#ensure(1);
        this.buf[this.len++] = v & 0xff;
    }

    bytes(arr) {
        this.#ensure(arr.length);
        this.buf.set(arr, this.len);
        this.len += arr.length;
    }

    /** 小端 16 位 —— GIF 容器里所有多字节整数都是小端 */
    u16(v) {
        this.byte(v & 0xff);
        this.byte((v >> 8) & 0xff);
    }

    str(s) {
        for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
    }

    /** 当前已写内容的视图（不拷贝） */
    get result() {
        return this.buf.subarray(0, this.len);
    }
}

// ── ① 量化：中位切分 ──────────────────────────────────────────

/** 跨所有帧均匀采样一批像素（纯色背景占多数，采样足够代表整体分布） */
function collectSamples(frames, budget) {
    let total = 0;
    for (const f of frames) total += f.length / 4;
    const step = Math.max(1, Math.floor(total / budget));

    const out = [];
    let counter = 0;
    for (const f of frames) {
        for (let i = 0; i < f.length; i += 4) {
            if (counter++ % step === 0) out.push(f[i], f[i + 1], f[i + 2]);
            if (out.length >= budget * 3) break;
        }
    }
    return Uint8Array.from(out);
}

/** 一个色盒的统计量：各通道极值与「最宽通道」 */
function boxStats(samples, idx, start, end) {
    let rMin = 255; let rMax = 0;
    let gMin = 255; let gMax = 0;
    let bMin = 255; let bMax = 0;
    for (let i = start; i < end; i++) {
        const p = idx[i] * 3;
        const r = samples[p]; const g = samples[p + 1]; const b = samples[p + 2];
        if (r < rMin) rMin = r;
        if (r > rMax) rMax = r;
        if (g < gMin) gMin = g;
        if (g > gMax) gMax = g;
        if (b < bMin) bMin = b;
        if (b > bMax) bMax = b;
    }
    const dr = rMax - rMin;
    const dg = gMax - gMin;
    const db = bMax - bMin;
    let axis = 0;
    let range = dr;
    if (dg > range) { axis = 1; range = dg; }
    if (db > range) { axis = 2; range = db; }
    return { axis, range };
}

/**
 * 中位切分（median cut）量化。
 *
 * 思路：先把所有采样点装进一个色盒，然后反复挑「颜色跨度最大」的盒子，
 * 沿它最宽的通道按中位数一分为二；切到 256 个盒子为止，每个盒子里
 * 像素的平均色就是一个调色板颜色。
 *
 * 为什么沿中位数切而不是均值：中位数保证两半**像素数相等**，
 * 于是像素密集的颜色区间会自动分到更多色盒 —— 这正是我们想要的
 * 「把颜色预算花在画面用得最多的地方」。
 */
function medianCut(samples, maxColors) {
    const n = samples.length / 3;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;

    const boxes = [{ start: 0, end: n, ...boxStats(samples, idx, 0, n) }];

    while (boxes.length < maxColors) {
        let pick = -1;
        let best = 0;
        for (let i = 0; i < boxes.length; i++) {
            const b = boxes[i];
            if (b.end - b.start < 2) continue;
            if (b.range > best) { best = b.range; pick = i; }
        }
        if (pick < 0) break;   // 剩下的盒子都已经只剩一种颜色

        const box = boxes[pick];
        const ch = box.axis;
        // 按最宽通道排序后从中位数切开（subarray 与原数组共享内存，排序即原地）
        const sub = idx.subarray(box.start, box.end);
        sub.sort((a, b) => samples[a * 3 + ch] - samples[b * 3 + ch]);
        const mid = (box.start + box.end) >> 1;

        boxes.splice(
            pick, 1,
            { start: box.start, end: mid, ...boxStats(samples, idx, box.start, mid) },
            { start: mid, end: box.end, ...boxStats(samples, idx, mid, box.end) },
        );
    }

    const palette = new Uint8Array(boxes.length * 3);
    boxes.forEach((b, i) => {
        let r = 0; let g = 0; let bl = 0;
        const count = b.end - b.start;
        for (let k = b.start; k < b.end; k++) {
            const p = idx[k] * 3;
            r += samples[p]; g += samples[p + 1]; bl += samples[p + 2];
        }
        palette[i * 3] = Math.round(r / count);
        palette[i * 3 + 1] = Math.round(g / count);
        palette[i * 3 + 2] = Math.round(bl / count);
    });
    return palette;
}

/**
 * 建「5 位 RGB → 调色板下标」查找表。
 *
 * 逐像素做 256 次距离比较太慢（一帧 14 万像素 × 60 帧 = 8 亿次比较）。
 * 把 RGB 各取高 5 位组成 15 位键（32768 项），每个键只算一次最近色，
 * 之后查表 O(1)。5 位精度（每通道 8 级）对 GIF 这种 256 色格式绰绰有余。
 */
function buildLookup(palette) {
    const colors = palette.length / 3;
    const lut = new Uint8Array(32768);
    for (let key = 0; key < 32768; key++) {
        // 键反解成该桶的中心色
        const r = (((key >> 10) & 31) << 3) | 4;
        const g = (((key >> 5) & 31) << 3) | 4;
        const b = ((key & 31) << 3) | 4;
        let bestI = 0;
        let bestD = Infinity;
        for (let i = 0; i < colors; i++) {
            const dr = r - palette[i * 3];
            const dg = g - palette[i * 3 + 1];
            const db = b - palette[i * 3 + 2];
            const d = dr * dr + dg * dg + db * db;
            if (d < bestD) { bestD = d; bestI = i; }
        }
        lut[key] = bestI;
    }
    return lut;
}

const lutKey = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// ── ② 索引化（可带抖动）──────────────────────────────────────

/**
 * Floyd–Steinberg 误差扩散：把「量化掉的那点误差」摊给右边和下面的像素。
 *
 * 不加抖动时，平滑渐变（分形的色彩、球面的明暗）会被硬生生切成一条条色带；
 * 抖动把误差变成细密噪点，肉眼看上去就是连续渐变。
 * 代价是文件变大（噪点更难被 LZW 压掉），所以留了开关。
 */
function ditherToIndices(pixels, width, height, palette, lut, out) {
    const errCur = new Float32Array(width * 3);
    const errNext = new Float32Array(width * 3);

    for (let y = 0; y < height; y++) {
        errNext.fill(0);
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;
            const r = clamp8(pixels[p] + errCur[x * 3]);
            const g = clamp8(pixels[p + 1] + errCur[x * 3 + 1]);
            const b = clamp8(pixels[p + 2] + errCur[x * 3 + 2]);

            const ci = lut[lutKey(r, g, b)];
            out[y * width + x] = ci;

            const er = r - palette[ci * 3];
            const eg = g - palette[ci * 3 + 1];
            const eb = b - palette[ci * 3 + 2];

            // 经典 FS 权重：右 7/16、左下 3/16、下 5/16、右下 1/16
            if (x + 1 < width) {
                errCur[(x + 1) * 3] += er * 0.4375;
                errCur[(x + 1) * 3 + 1] += eg * 0.4375;
                errCur[(x + 1) * 3 + 2] += eb * 0.4375;
                errNext[(x + 1) * 3] += er * 0.0625;
                errNext[(x + 1) * 3 + 1] += eg * 0.0625;
                errNext[(x + 1) * 3 + 2] += eb * 0.0625;
            }
            if (x > 0) {
                errNext[(x - 1) * 3] += er * 0.1875;
                errNext[(x - 1) * 3 + 1] += eg * 0.1875;
                errNext[(x - 1) * 3 + 2] += eb * 0.1875;
            }
            errNext[x * 3] += er * 0.3125;
            errNext[x * 3 + 1] += eg * 0.3125;
            errNext[x * 3 + 2] += eb * 0.3125;
        }
        errCur.set(errNext);
    }
}

function mapToIndices(pixels, count, lut, out) {
    for (let i = 0, p = 0; i < count; i++, p += 4) {
        out[i] = lut[lutKey(pixels[p], pixels[p + 1], pixels[p + 2])];
    }
}

// ── ③ LZW + GIF89a 容器 ──────────────────────────────────────

/**
 * GIF 版 LZW 压缩。
 *
 * 与通用 LZW 的区别只有三处（都来自 GIF 规格）：
 *   - 码长从 minCodeSize+1 位起步，字典每满 2^码长 就加 1 位，上限 12 位
 *   - 字典满了（4096 项）不能继续扩，要吐一个「清除码」把字典清空重来
 *   - 码流是**低位在前**打包的（一次吐 8 位）
 *
 * @param {Uint8Array} indices 调色板下标
 * @param {number} minCodeSize 根码位数（本项目固定 8）
 * @returns {Uint8Array} 压缩后的原始字节（还没分块）
 */
export function lzwEncode(indices, minCodeSize) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;

    const out = [];
    let cur = 0;
    let curBits = 0;
    let codeSize = minCodeSize + 1;
    const emit = (code) => {
        cur |= code << curBits;
        curBits += codeSize;
        while (curBits >= 8) {
            out.push(cur & 0xff);
            cur >>= 8;
            curBits -= 8;
        }
    };

    let table = new Map();
    let nextCode = eoiCode + 1;
    emit(clearCode);

    if (!indices.length) {
        emit(eoiCode);
        if (curBits > 0) out.push(cur & 0xff);
        return Uint8Array.from(out);
    }

    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
        const k = indices[i];
        const key = (prefix << 8) | k;
        const hit = table.get(key);
        if (hit !== undefined) {
            prefix = hit;
            continue;
        }
        emit(prefix);
        if (nextCode === 4096) {
            // 字典满：清空重来。注意清除码用的是**当前**码长，然后再缩回去
            emit(clearCode);
            table = new Map();
            nextCode = eoiCode + 1;
            codeSize = minCodeSize + 1;
        } else {
            if (nextCode >= (1 << codeSize)) codeSize++;
            table.set(key, nextCode++);
        }
        prefix = k;
    }
    emit(prefix);
    emit(eoiCode);
    if (curBits > 0) out.push(cur & 0xff);
    return Uint8Array.from(out);
}

/** 把压缩数据切成 ≤255 字节的子块（GIF 容器规定） */
function writeSubBlocks(w, data) {
    for (let i = 0; i < data.length; i += 255) {
        const n = Math.min(255, data.length - i);
        w.byte(n);
        w.bytes(data.subarray(i, i + n));
    }
    w.byte(0);   // 块终止符
}

/**
 * 把一串同尺寸的 RGBA 帧编码成一张循环播放的 GIF。
 *
 * @param {Uint8ClampedArray[]} frames 每帧像素（RGBA，行优先）
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 * @param {number} [opts.delayCs] 每帧显示时长，单位 1/100 秒（GIF 的时间分辨率只有 10ms）
 * @param {number} [opts.loop] 循环次数，0 = 无限循环
 * @param {boolean} [opts.dither] 是否做误差扩散抖动（默认开）
 * @param {(stage: string, done: number, total: number) => void} [opts.onProgress]
 * @returns {Blob}
 */
export function encodeGif(frames, width, height, opts = {}) {
    const {
        delayCs = 8,
        loop = 0,
        dither = true,
        onProgress = null,
    } = opts;

    if (!frames?.length) throw new Error('GIF 编码：没有帧');
    const count = Math.min(frames.length, MAX_GIF_FRAMES);

    onProgress?.('quantize', 0, 1);
    const samples = collectSamples(frames.slice(0, count), SAMPLE_BUDGET);
    const rawPalette = medianCut(samples, MAX_COLORS);

    // 全局色表长度必须是 2 的幂且 ≥2；不足 256 时补零
    let tableSize = 2;
    while (tableSize < rawPalette.length / 3) tableSize *= 2;
    const palette = new Uint8Array(tableSize * 3);
    palette.set(rawPalette);
    const tableBits = Math.log2(tableSize);
    const minCodeSize = Math.max(2, tableBits);

    const lut = buildLookup(palette);

    onProgress?.('encode', 0, count);
    const w = new ByteWriter();
    w.str('GIF89a');
    w.u16(width);
    w.u16(height);
    // 全局色表标志(0x80) | 颜色分辨率 7(0x70) | 排序 0 | 表大小
    w.byte(0x80 | 0x70 | (tableBits - 1));
    w.byte(0);          // 背景色下标
    w.byte(0);          // 像素宽高比（0 = 不指定）
    w.bytes(palette);

    // NETSCAPE2.0 循环扩展：没有它，多数播放器只播一遍
    w.byte(0x21);
    w.byte(0xff);
    w.byte(11);
    w.str('NETSCAPE2.0');
    w.byte(3);
    w.byte(1);
    w.u16(loop);
    w.byte(0);

    const indices = new Uint8Array(width * height);
    for (let i = 0; i < count; i++) {
        if (dither) ditherToIndices(frames[i], width, height, palette, lut, indices);
        else mapToIndices(frames[i], width * height, lut, indices);

        // 图形控制扩展：处置方式 1（保留上一帧）、延时、无透明色
        w.byte(0x21);
        w.byte(0xf9);
        w.byte(4);
        w.byte(0x04);
        w.u16(delayCs);
        w.byte(0);
        w.byte(0);

        // 图像描述符：全屏、无局部色表、非交错
        w.byte(0x2c);
        w.u16(0);
        w.u16(0);
        w.u16(width);
        w.u16(height);
        w.byte(0);

        w.byte(minCodeSize);
        writeSubBlocks(w, lzwEncode(indices, minCodeSize));
        onProgress?.('encode', i + 1, count);
    }

    w.byte(0x3b);   // 文件结束

    return new Blob([w.result.slice()], { type: 'image/gif' });
}

/** 同上，但返回原始字节（Node 测试与需要自己处理字节时用） */
export function encodeGifBytes(frames, width, height, opts = {}) {
    const blob = encodeGif(frames, width, height, opts);
    return blob.arrayBuffer().then((b) => new Uint8Array(b));
}
