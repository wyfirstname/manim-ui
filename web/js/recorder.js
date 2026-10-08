/**
 * 动画录制 —— 把画布上的动画录成 WebM。
 *
 * 为什么用 MediaRecorder 而不是自己编码：
 *   浏览器自带 VP8/VP9 编码器，`canvas.captureStream()` 又能直接抓画布，
 *   两者一接就是零依赖的视频导出。若改用 WebCodecs 逐帧编码，为了
 *   拿到精确的帧时间戳得自己写 WebM 封装（几百行 muxer），而本项目
 *   的约束是「零依赖、本地跑」，不划算。
 *
 * 代价（用之前要知道）：
 *   - 录制是**实时**的：录 10 秒就要播 10 秒，不能快进；
 *   - 帧率取决于实际渲染性能，机器卡则帧率掉、时长不变；
 *   - 想录得稳，录制期间别去动滑块（参数一变，画面就跳）。
 *
 * 用法：
 *   const rec = new CanvasRecorder(canvas);
 *   rec.start({ fps: 30 });            // 开始
 *   const { blob, duration } = await rec.stop();   // 停止并拿到文件
 */

/** 按优选顺序试探的容器/编码：VP9 画质好，VP8 兼容广，最后要一个裸 webm */
const CANDIDATE_TYPES = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
];

const INFO_ID = [0x15, 0x49, 0xa9, 0x66];   // EBML: Segment > Info
const DURATION_ID = [0x44, 0x89];           // EBML: Info > Duration

/** 在 [from, to) 里找一段字节序列，找不到返回 -1 */
function indexOfBytes(hay, needle, from = 0, to = hay.length) {
    const last = Math.min(to, hay.length) - needle.length;
    outer:
    for (let i = from; i <= last; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (hay[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}

/**
 * 给 MediaRecorder 产出的 WebM 补上 Duration 元素。
 *
 * 为什么要补：Chromium 系的 MediaRecorder **从不写 Duration**。文件在浏览器里
 * 能正常播，但拖进剪辑软件或不少播放器会「时长未知、进度条拖不动」——
 * 看起来像坏文件。录制功能交付的是文件本身，不能只保证浏览器能播。
 *
 * 好在它同时把 Segment 的长度写成了「未知」（01 FF FF …），
 * 也就是没有任何父级元素需要回填长度，只在 Info 内部插 11 字节、
 * 并把 Info 自己的长度字节改大即可。
 *
 * @param {Blob} blob 原始 webm
 * @param {number} durationMs 时长（毫秒，与 TimecodeScale=1ms 一致）
 * @returns {Promise<Blob>} 补好 Duration 的 webm（补不了时原样返回）
 */
export async function patchWebmDuration(blob, durationMs) {
    try {
        const src = new Uint8Array(await blob.arrayBuffer());
        // Info 一定在文件最前面（EBML 头 36 字节之后就跟着它），扫前 128 字节足够
        const at = indexOfBytes(src, INFO_ID, 0, 128);
        if (at < 0) return blob;

        const sizeByte = src[at + 4];
        if ((sizeByte & 0x80) === 0) return blob;        // 多字节 VINT：结构不同，不冒险
        const infoLen = sizeByte & 0x7f;
        const newLen = infoLen + 11;                     // Duration 元素固定 11 字节
        if (newLen > 0x7f) return blob;                  // 超出单字节 VINT 表达范围

        const infoEnd = at + 5 + infoLen;
        // 已经带 Duration 就别重复插
        if (indexOfBytes(src, DURATION_ID, at + 5, infoEnd) >= 0) return blob;

        const dur = new Uint8Array(11);
        dur.set(DURATION_ID, 0);                         // 44 89
        dur[2] = 0x88;                                   // 长度 8：双精度浮点
        new DataView(dur.buffer).setFloat64(3, durationMs, false);   // 大端

        const out = new Uint8Array(src.length + 11);
        out.set(src.subarray(0, infoEnd), 0);
        out.set(dur, infoEnd);
        out.set(src.subarray(infoEnd), infoEnd + 11);
        out[at + 4] = 0x80 | newLen;                     // Info 长度 +11
        return new Blob([out], { type: blob.type });
    } catch {
        // 补时长只是锦上添花，任何意外都别把成片弄丢
        return blob;
    }
}

export class CanvasRecorder {
    constructor(canvas) {
        this.canvas = canvas;
        this.recorder = null;
        this.stream = null;
        this.chunks = [];
        this.mimeType = '';
        this.startedAt = 0;
        this.bytes = 0;
        /** 是否在停止时补写 Duration（见 patchWebmDuration） */
        this.fixDuration = true;
    }

    /** 环境是否支持（不支持时 UI 把按钮置灰，而不是点了没反应） */
    static supported() {
        return typeof MediaRecorder !== 'undefined'
            && typeof HTMLCanvasElement !== 'undefined'
            && typeof HTMLCanvasElement.prototype.captureStream === 'function'
            && !!CanvasRecorder.pickMimeType();
    }

    /** 挑一个本机支持的容器/编码，全不支持则返回 '' */
    static pickMimeType() {
        if (typeof MediaRecorder === 'undefined') return '';
        for (const m of CANDIDATE_TYPES) {
            try {
                if (MediaRecorder.isTypeSupported(m)) return m;
            } catch {
                /* 某些实现对畸形字符串抛错，忽略继续试下一个 */
            }
        }
        return '';
    }

    get recording() {
        return this.recorder?.state === 'recording';
    }

    /** 已录时长（秒） */
    get elapsed() {
        return this.recording ? (performance.now() - this.startedAt) / 1000 : 0;
    }

    /** 已收到的字节数（用来在按钮上显示个进度感） */
    get size() {
        return this.bytes;
    }

    get extension() {
        return 'webm';
    }

    /**
     * 开始录制。
     * @param {object} [opts]
     * @param {number} [opts.fps] 期望帧率（浏览器只把它当上限）
     * @param {number} [opts.bitrate] 视频码率，默认按画布尺寸估
     * @param {boolean} [opts.fixDuration] 停止时是否补写 Duration
     * @returns {boolean} 是否真的开录了
     */
    start({ fps = 30, bitrate = 0, fixDuration = true } = {}) {
        if (this.recording) return false;
        this.fixDuration = fixDuration;
        if (!CanvasRecorder.supported()) {
            const err = new Error('MEDIARECORDER_UNSUPPORTED');
            err.code = 'MEDIARECORDER_UNSUPPORTED';
            throw err;
        }
        this.mimeType = CanvasRecorder.pickMimeType();
        this.chunks = [];
        this.bytes = 0;

        // captureStream(fps) 的帧率是上限，实际帧跟着画布重绘走
        this.stream = this.canvas.captureStream(fps);
        this.recorder = new MediaRecorder(this.stream, {
            mimeType: this.mimeType,
            videoBitsPerSecond: bitrate || CanvasRecorder.estimateBitrate(this.canvas, fps),
        });
        this.recorder.ondataavailable = (e) => {
            if (e.data && e.data.size) {
                this.chunks.push(e.data);
                this.bytes += e.data.size;
            }
        };
        // 分片吐出：录久了不会把所有数据堆在编码器里
        this.recorder.start(500);
        this.startedAt = performance.now();
        return true;
    }

    /**
     * 停止并取回文件。
     * @returns {Promise<{blob: Blob, mimeType: string, duration: number, extension: string}|null>}
     */
    stop() {
        return new Promise((resolve, reject) => {
            const rec = this.recorder;
            if (!rec || rec.state === 'inactive') {
                this.#cleanup();
                resolve(null);
                return;
            }
            const duration = (performance.now() - this.startedAt) / 1000;
            rec.onstop = async () => {
                let blob = new Blob(this.chunks, { type: this.mimeType });
                const mimeType = this.mimeType;
                this.#cleanup();
                // 挂钟时长当作视频时长：时间戳跟着真实时间走，差在毫秒级
                if (this.fixDuration) blob = await patchWebmDuration(blob, duration * 1000);
                resolve({ blob, mimeType, duration, extension: 'webm' });
            };
            rec.onerror = (e) => {
                this.#cleanup();
                reject(e?.error ?? new Error('MediaRecorder failed'));
            };
            try {
                rec.stop();
            } catch (e) {
                this.#cleanup();
                reject(e);
            }
        });
    }

    /** 丢弃当前录制（切换模块等场景） */
    cancel() {
        try {
            if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
        } catch {
            /* 已停就无所谓 */
        }
        this.#cleanup();
    }

    #cleanup() {
        this.stream?.getTracks?.().forEach((t) => t.stop());
        this.stream = null;
        this.recorder = null;
        this.chunks = [];
        this.bytes = 0;
    }

    /**
     * 码率估算：VP9 在 0.1 bit/像素/帧 左右能保住曲线边缘，
     * 上下限夹一下 —— 太低糊，太高对集显编码是负担。
     */
    static estimateBitrate(canvas, fps) {
        const px = (canvas?.width ?? 1280) * (canvas?.height ?? 720);
        const raw = px * fps * 0.1;
        return Math.round(Math.min(24e6, Math.max(3e6, raw)));
    }
}

/** 触发浏览器下载（导 PNG 与导视频共用） */
export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻 revoke 会让部分浏览器拿到空文件，留出下载启动的时间
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
