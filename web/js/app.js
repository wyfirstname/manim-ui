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
import { t, getLang, setLang, onLangChange, applyStaticI18n, LANGS } from './i18n.js';

const $ = (sel) => document.querySelector(sel);

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
            label: this.playing ? t('btn.pause') : t('btn.play'),
            onClick: () => {
                if (!playable) return;
                this.playing = !this.playing;
                play.setLabel(this.playing ? t('btn.pause') : t('btn.play'));
                if (this.playing) this.#playLoop();
            },
        });
        play.el.disabled = !playable;
        this.playBtn = play;
        actions.appendChild(play.element);

        panel.appendChild(actions);
        this.panel.sync();
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
