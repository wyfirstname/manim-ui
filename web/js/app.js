/**
 * 应用入口
 *
 * 环境自检要点（曾踩过的坑）：
 * WebGPU 只在「安全上下文」下存在。若用 file:// 打开，navigator.gpu 会是 undefined，
 * 表现为「这台机器不支持 WebGPU」，极具误导性。因此本文件对两种情况分别给出提示。
 *
 * 架构：本文件只做「壳」——模块切换、参数面板、画布事件转发、渲染循环。
 * 具体模块的预设、参数、交互语义都在 web/js/modules/ 下，经 registry.js 注册进来。
 *
 * 国际化：静态文本走 index.html 的 data-i18n，动态控件在语言切换时整体重建
 * （见 i18n.js）。切换语言不会重新初始化 WebGPU，也不会丢失当前参数。
 */

import { Gpu } from './gpu.js';
import { MODULES, getModule } from './modules/registry.js';
import { buildPanel } from './panel.js';
import { Button, CanvasController } from './controls.js';
import { CanvasRecorder, downloadBlob } from './recorder.js';
import { encodeGif } from './gif.js';
import { t, getLang, setLang, onLangChange, applyStaticI18n, LANGS } from './i18n.js';

const $ = (sel) => document.querySelector(sel);

/** 录制帧率上限（浏览器按实际重绘节奏走，这只是个上限） */
const RECORD_FPS = 30;
/** 录制上限：忘了点停止也不至于把内存录爆，到点自动保存 */
const RECORD_MAX_SECONDS = 120;

/** GIF 导出：帧数、每帧时长（1/100 秒）、像素宽上限 */
const GIF_FRAMES = 60;
const GIF_DELAY_CS = 7;
const GIF_MAX_WIDTH = 600;

/** 人类可读的文件大小（日志里显示用） */
function fmtSize(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 文件名用的时间戳，形如 20261008-141530 */
function timeStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
        + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

class App {
    constructor() {
        this.gpu = new Gpu();

        // 模块实例按 id 缓存，切回来时保留上次的参数与视角
        this.instances = new Map();
        this.desc = MODULES[0];
        this.activeId = MODULES[0].id;
        this.module = this.desc.create(this.gpu);
        this.instances.set(this.activeId, this.module);

        this.running = false;
        this.playing = false;
        this.recorder = null;
        this.panelReady = false;
        this.needsRender = true;
        this.log = [];
    }

    logStep(msg) {
        this.log.push(msg);
        const el = $('#log');
        if (el) el.textContent = this.log.slice(-6).join('\n');
    }

    async start() {
        const canvas = $('#view');

        applyStaticI18n();
        this.#setupLangSwitch();
        onLangChange(() => this.#onLangChanged());

        // ── 环境自检 ───────────────────────────────
        if (!window.isSecureContext) {
            this.showFatal(
                t('fatal.secure.title'),
                t('fatal.secure.body'),
                t('fatal.secure.detail')
            );
            return;
        }
        if (!navigator.gpu) {
            this.showFatal(
                t('fatal.nogpu.title'),
                t('fatal.nogpu.body'),
                t('fatal.nogpu.detail')
            );
            return;
        }

        try {
            this.logStep(t('log.init'));
            await this.gpu.init(canvas);
            const i = this.gpu.adapterInfo ?? {};
            this.logStep(t('log.adapter', { name: `${i.vendor ?? '?'} ${i.architecture ?? ''}`.trim() }));
            this.#showDeviceInfo();
        } catch (e) {
            if (e.code === 'NO_ADAPTER') {
                this.showFatal(
                    t('fatal.noadapter.title'),
                    t('fatal.noadapter.body'),
                    t('fatal.noadapter.detail')
                );
            } else {
                this.showFatal(t('fatal.init.title'), String(e.message ?? e), '');
            }
            return;
        }

        this.#setupLayout();
        this.#rebuildUI();
        this.#setupCanvasInteraction();

        this.logStep(t('log.loading'));
        try {
            await this.module.loadPreset(this.module.preset.id);
        } catch (e) {
            this.#reportShaderError(e);
            return;
        }

        this.module.applyCamera();
        this.gpu.updateFrameUniform();
        this.logStep(t('log.ready'));
        this.#loop();
    }

    #reportShaderError(e) {
        console.error(e);
        this.logStep(t('log.shaderErr', { msg: e.message }));
        const detail = e.detail ? `\n\n${e.detail.slice(0, 800)}` : '';
        this.showFatal(t('fatal.shader.title'), `<pre>${escapeHtml(e.message)}</pre>${detail}`, '');
    }

    // ── 语言 ────────────────────────────────────

    #setupLangSwitch() {
        this.#renderLangSwitch();
    }

    #renderLangSwitch() {
        const box = $('#lang-switch');
        if (!box) return;
        box.innerHTML = '';
        for (const L of LANGS) {
            const b = document.createElement('button');
            b.className = 'lang-btn' + (L.id === getLang() ? ' active' : '');
            b.textContent = L.label;
            b.title = L.id === 'zh' ? '中文' : 'English';
            b.addEventListener('click', () => setLang(L.id));
            box.appendChild(b);
        }
    }

    /** 语言变化：重刷静态文本 + 动态控件（不重启 WebGPU，不丢参数） */
    #onLangChanged() {
        applyStaticI18n();
        this.#renderLangSwitch();
        if (this.gpu.adapterInfo) this.#showDeviceInfo();
        if (this.panelReady) this.#rebuildUI();
    }

    #showDeviceInfo() {
        const i = this.gpu.adapterInfo ?? {};
        const el = $('#device');
        if (!el) return;
        const name = [i.vendor, i.architecture, i.device].filter(Boolean).join(' · ');
        el.innerHTML = name ? t('device.gpu', { name: escapeHtml(name) }) : t('device.ready');
    }

    // ── 布局与面板 ───────────────────────────────

    #setupLayout() {
        const wrap = $('#stage');
        const resize = () => {
            const r = wrap.getBoundingClientRect();
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const w = Math.max(1, Math.floor(r.width * dpr));
            const h = Math.max(1, Math.floor(r.height * dpr));
            this.gpu.resize(w, h);
            this.needsRender = true;
        };
        new ResizeObserver(resize).observe(wrap);
        resize();
    }

    /** 模块页签 + 场景列表 + 参数面板统一重建（语言切换时复用它） */
    #rebuildUI() {
        this.#buildModuleTabs();
        this.#buildScenes();
        this.#buildPanel();
        this.panelReady = true;
    }

    #buildModuleTabs() {
        const box = $('#module-tabs');
        if (!box) return;
        box.innerHTML = '';
        for (const m of MODULES) {
            const b = document.createElement('button');
            b.className = 'module-tab' + (m.id === this.activeId ? ' active' : '');
            b.textContent = t(m.nameKey);
            b.addEventListener('click', () => this.#switchModule(m.id));
            box.appendChild(b);
        }
    }

    /** 切换模块：取（或新建）实例，载入默认预设后重建 UI */
    async #switchModule(id) {
        if (id === this.activeId) return;
        // 录制中切模块：先把这一段存下来，免得视频录到一半换了内容
        if (this.recorder?.recording) await this.#finishRecord();
        const desc = getModule(id);
        let inst = this.instances.get(id);
        if (!inst) {
            inst = desc.create(this.gpu);
            this.instances.set(id, inst);
        }
        try {
            await inst.loadPreset(inst.preset.id);
        } catch (e) {
            this.#reportShaderError(e);
            return;
        }
        inst.applyCamera();
        this.desc = desc;
        this.module = inst;
        this.activeId = id;
        this.#rebuildUI();
        this.needsRender = true;
    }

    #buildScenes() {
        const list = $('#scenes');
        if (!list) return;
        list.innerHTML = '';
        for (const p of this.desc.presets) {
            const b = document.createElement('button');
            b.className = 'scene-item' + (p.id === this.module.preset.id ? ' active' : '');
            const nameEl = document.createElement('span');
            nameEl.className = 'scene-name';
            nameEl.textContent = t(p.nameKey);
            const hintEl = document.createElement('span');
            hintEl.className = 'scene-hint';
            hintEl.textContent = t(p.hintKey);
            b.appendChild(nameEl);
            b.appendChild(hintEl);
            b.addEventListener('click', async () => {
                document.querySelectorAll('.scene-item').forEach((x) => x.classList.remove('active'));
                b.classList.add('active');
                await this.module.loadPreset(p.id);
                this.module.applyCamera();
                this.panel?.sync();
                this.needsRender = true;
                this.logStep(t('log.switch', { name: t(p.nameKey) }));
            });
            list.appendChild(b);
        }
    }

    #buildPanel() {
        const panel = $('#params');
        if (!panel) return;

        // 模块自己声明的参数控件
        this.panel = buildPanel(panel, this.desc.panel, this.module, () => {
            this.module.update();
            this.needsRender = true;
        });

        // 通用动作：导出 / 重置 / 播放
        const actions = document.createElement('div');
        actions.className = 'panel-actions';

        const btn = new Button({
            label: t('btn.export'),
            onClick: async () => {
                btn.el.disabled = true;
                btn.setLabel(t('btn.exporting'));
                try {
                    const url = await this.module.toPNG();
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${this.module.preset.id}.png`;
                    a.click();
                    this.logStep(t('log.exported'));
                } catch (e) {
                    this.logStep(t('log.exportFail', { msg: e.message }));
                }
                btn.el.disabled = false;
                btn.setLabel(t('btn.export'));
            },
        });
        actions.appendChild(btn.element);

        const reset = new Button({
            label: t('btn.reset'),
            onClick: async () => {
                await this.module.loadPreset(this.module.preset.id);
                this.module.applyCamera();
                this.panel?.sync();
                this.needsRender = true;
            },
        });
        actions.appendChild(reset.element);

        // 播放：模块未实现 playStep() 时不可用
        const playable = typeof this.module.playStep === 'function';
        const play = new Button({
            label: t('btn.play'),
            onClick: () => {
                if (playable) this.#setPlaying(!this.playing);
            },
        });
        play.el.disabled = !playable;
        this.playBtn = play;
        actions.appendChild(play.element);

        // 录制动画：只有能播放的模块才录得出视频
        const recordable = playable && CanvasRecorder.supported();
        const record = new Button({
            label: t('btn.record'),
            onClick: () => this.#toggleRecord(),
        });
        record.el.disabled = !recordable;
        if (!CanvasRecorder.supported()) {
            record.el.title = t('record.unsupported');
        } else if (!playable) {
            record.el.title = t('record.noplay');
        }
        this.recordBtn = record;
        actions.appendChild(record.element);

        // 导出 GIF：离屏逐帧渲染，与实时的录制是两条完全不同的路
        const gif = new Button({
            label: t('btn.gif'),
            onClick: () => this.#exportGif(),
        });
        gif.el.disabled = !playable;
        if (!playable) gif.el.title = t('record.noplay');
        this.gifBtn = gif;
        actions.appendChild(gif.element);

        panel.appendChild(actions);
        this.panel.sync();
        // 面板可能因切语言被重建，把播放/录制的真实状态贴回去
        this.#syncPlayButton();
        this.#syncRecordButton();
    }

    #setupCanvasInteraction() {
        this.controller = new CanvasController($('#view'), {
            onChange: (e) => this.module.handleCanvasEvent?.(e, {
                gpu: this.gpu,
                canvas: $('#view'),
                invalidate: () => { this.needsRender = true; },
                syncPanel: () => this.panel?.sync(),
            }),
        });
    }

    #playLoop() {
        if (this._playTimer) return;
        const tick = () => {
            if (!this.playing) { this._playTimer = null; return; }
            this.module.playStep?.();
            this.panel?.sync();
            this.needsRender = true;
            this._playTimer = setTimeout(tick, 16);
        };
        this._playTimer = setTimeout(tick, 16);
    }

    /** 播放开关的唯一入口：按钮文字、循环、录制联动都从这里走 */
    #setPlaying(v) {
        this.playing = !!v;
        this.#syncPlayButton();
        if (this.playing) this.#playLoop();
    }

    #syncPlayButton() {
        this.playBtn?.setLabel(this.playing ? t('btn.pause') : t('btn.play'));
    }

    // ── 动画录制 ─────────────────────────────────

    /**
     * 「录制动画」按钮：按一下开始、再按一下停止并保存。
     * 录制期间自动开播 —— 画面不动就没什么可录的。
     */
    async #toggleRecord() {
        if (this.recorder?.recording) {
            await this.#finishRecord();
            return;
        }
        if (!CanvasRecorder.supported()) {
            this.logStep(t('log.recordUnsupported'));
            return;
        }
        if (typeof this.module.playStep !== 'function') {
            this.logStep(t('log.recordNoPlay'));
            return;
        }

        this.recorder = this.recorder ?? new CanvasRecorder($('#view'));
        try {
            this.recorder.start({ fps: RECORD_FPS });
        } catch (e) {
            this.logStep(t('log.recordFail', { msg: e.message }));
            return;
        }
        this.#setPlaying(true);
        this.#startRecordTimer();
        this.#syncRecordButton();
        this.logStep(t('log.recording', { fps: RECORD_FPS }));
    }

    /** 停止录制 → 下载文件。切模块、到达上限也会走这里。 */
    async #finishRecord() {
        if (!this.recorder?.recording) return;
        this.#stopRecordTimer();
        let result = null;
        try {
            result = await this.recorder.stop();
        } catch (e) {
            this.logStep(t('log.recordFail', { msg: e.message }));
        }
        this.#setPlaying(false);
        this.#syncRecordButton();

        if (!result || !result.blob.size) {
            this.logStep(t('log.recordEmpty'));
            return;
        }
        const name = `${this.module.preset.id}-${timeStamp()}.webm`;
        downloadBlob(result.blob, name);
        this.logStep(t('log.recorded', { name, s: result.duration.toFixed(1) }));
    }

    #startRecordTimer() {
        this.#stopRecordTimer();
        this._recTimer = setInterval(() => {
            if (!this.recorder?.recording) { this.#stopRecordTimer(); return; }
            this.#syncRecordButton();
            if (this.recorder.elapsed >= RECORD_MAX_SECONDS) {
                this.logStep(t('log.recordLimit', { s: RECORD_MAX_SECONDS }));
                this.#finishRecord();
            }
        }, 200);
    }

    #stopRecordTimer() {
        if (this._recTimer) clearInterval(this._recTimer);
        this._recTimer = null;
    }

    #syncRecordButton() {
        const btn = this.recordBtn;
        if (!btn) return;
        const on = !!this.recorder?.recording;
        btn.setLabel(on
            ? t('btn.recording', { s: this.recorder.elapsed.toFixed(1) })
            : t('btn.record'));
        btn.el.classList.toggle('recording', on);
    }

    // ── GIF 导出 ─────────────────────────────────

    /**
     * 把模块实例的当前状态整体快照下来。
     *
     * 为什么需要：GIF 导出靠反复调 playStep() 推进动画（否则 60 帧长得一模一样），
     * 这会真的改掉模块的参数与动画状态。导出完得原样还回去，不然用户会发现
     * 「导出一次，画面自己变了」。
     *
     * gpu / entries / passes 是渲染管线对象（含 GPU 句柄），不参与快照；
     * 函数属性同理跳过。其余一律深拷贝（预设是纯数据，params 是纯数据）。
     */
    #snapshotModule() {
        const inst = this.module;
        const snap = {};
        for (const [k, v] of Object.entries(inst)) {
            if (k === 'gpu' || k === 'entries' || k === 'passes') continue;
            if (typeof v === 'function') continue;
            try {
                snap[k] = (v && typeof v === 'object') ? structuredClone(v) : v;
            } catch {
                /* 含不可克隆的东西就跳过这一项，不影响导出本身 */
            }
        }
        return snap;
    }

    #restoreModule(snap) {
        Object.assign(this.module, snap);
        this.module.update?.();
        this.panel?.sync();
        this.needsRender = true;
    }

    /**
     * 导出 GIF —— 与「录制动画」是两条完全不同的路：
     *   录制  实时抓画布（captureStream），录多久就得播多久
     *   GIF   **逐帧离屏渲染**：调一次 playStep() 渲染一帧读回像素，
     *         60 帧就是调 60 次，与播放时长无关，帧率恒定
     */
    async #exportGif() {
        if (this._gifBusy) return;
        if (typeof this.module.playStep !== 'function') {
            this.logStep(t('log.recordNoPlay'));
            return;
        }
        this._gifBusy = true;

        const btn = this.gifBtn;
        const wasPlaying = this.playing;
        this.#setPlaying(false);
        if (btn) btn.el.disabled = true;

        const snap = this.#snapshotModule();
        // 与外层画布同宽高比：GIF 只是等比缩小，构图与屏幕上看到的一致
        const scale = Math.min(1, GIF_MAX_WIDTH / this.gpu.width);
        const w = Math.max(2, Math.round(this.gpu.width * scale));
        const h = Math.max(2, Math.round(this.gpu.height * scale));

        // 相机也要按离屏分辨率走一遍：着色器的抗锯齿宽度是按「一个像素对应多少
        // 场景单位」算的，沿用屏幕分辨率会让缩小后的边缘糊掉或起毛。
        const cam = this.gpu.camera;
        const savedPixels = [cam.pixelWidth, cam.pixelHeight];
        cam.resize(w, h);

        const t0 = performance.now();
        this.logStep(t('log.gifStart', { n: GIF_FRAMES }));
        try {
            const frames = [];
            for (let i = 0; i < GIF_FRAMES; i++) {
                this.module.playStep();
                this.gpu.updateFrameUniform();
                const { pixels } = await this.gpu.renderToPixels(this.module.draws, w, h);
                frames.push(pixels);
                btn?.setLabel(t('btn.gifWorking', { pct: Math.round(((i + 1) / GIF_FRAMES) * 100) }));
            }

            const blob = encodeGif(frames, w, h, { delayCs: GIF_DELAY_CS });
            const secs = ((performance.now() - t0) / 1000).toFixed(1);
            const name = `${this.module.preset.id}.gif`;
            downloadBlob(blob, name);
            this.logStep(t('log.gifDone', {
                name, n: GIF_FRAMES, size: fmtSize(blob.size), s: secs,
            }));
        } catch (e) {
            console.error(e);
            this.logStep(t('log.gifFail', { msg: e.message }));
        } finally {
            cam.resize(savedPixels[0], savedPixels[1]);
            this.#restoreModule(snap);
            if (btn) {
                btn.setLabel(t('btn.gif'));
                btn.el.disabled = false;
            }
            this._gifBusy = false;
            if (wasPlaying) this.#setPlaying(true);
        }
    }

    #loop() {
        this.running = true;
        const frame = () => {
            if (!this.running) return;
            this.gpu.updateFrameUniform();
            this.gpu.render(this.module.draws);
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }

    showFatal(title, html, detail) {
        const box = $('#fatal');
        box.style.display = 'flex';
        $('#fatal-title').textContent = title;
        $('#fatal-body').innerHTML = html;
        $('#log').textContent = detail;
        console.error('[fatal]', title, detail);
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

applyStaticI18n();

const app = new App();
window.__app = app;
app.start().catch((e) => {
    console.error(e);
    app.showFatal(t('fatal.start.title'), String(e.message ?? e), '');
});
