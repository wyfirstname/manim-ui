/**
 * 交互控件库 —— 移植自 3b1b/manim 的 manimlib/mobject/interactive.py
 *
 * 上游把 Button / Checkbox / LinearNumberSlider / Textbox / ControlPanel
 * 做成场景里的 Mobject，用鼠标事件驱动。本项目改为 DOM 实现，行为语义保持一致：
 *   - 拖动滑块 → 值连续变化 → 回调
 *   - 复选框→ 布尔切换
 *   - 颜色滑块 → RGBA
 *
 * 事件映射（对齐上游 event_handler/event_type.py 的 7 种事件）：
 *   MouseMotionEvent   → mousemove / pointermove
 *   MousePressEvent    → pointerdown
 *   MouseReleaseEvent  → pointerup
 *   MouseDragEvent     → pointermove（按下时）
 *   MouseScrollEvent   → wheel
 *   KeyPressEvent      → keydown
 *   KeyReleaseEvent    → keyup
 */

export class Emitter {
    constructor() {
        this.handlers = new Map();
    }
    on(evt, fn) {
        if (!this.handlers.has(evt)) this.handlers.set(evt, []);
        this.handlers.get(evt).push(fn);
        return this;
    }
    emit(evt, payload) {
        for (const fn of this.handlers.get(evt) ?? []) fn(payload);
    }
}

/** 数值滑块：对应上游 LinearNumberSlider */
export class Slider {
    constructor({
        label, min = 0, max = 1, step = 0.01, value = 0.5,
        onChange = () => {}, format = (v) => v.toFixed(2),
    }) {
        this.min = min; this.max = max; this.step = step;
        this.value = value;
        this.onChange = onChange;
        this.format = format;
        this.el = this.#build(label);
        this.setValue(value, false);
    }

    #build(label) {
        const wrap = document.createElement('div');
        wrap.className = 'ctrl';
        wrap.innerHTML = `
            <div class="ctrl-head">
                <span class="ctrl-label"></span>
                <span class="ctrl-value"></span>
            </div>
            <input type="range" class="ctrl-range" />
        `;
        this.labelEl = wrap.querySelector('.ctrl-label');
        this.labelEl.textContent = label;
        const range = wrap.querySelector('input');
        range.min = String(min2(this.min));
        range.max = String(min2(this.max));
        range.step = String(this.step);
        range.value = String(this.value);
        range.addEventListener('input', () => {
            this.setValue(parseFloat(range.value), true);
        });
        this.input = range;
        this.valueEl = wrap.querySelector('.ctrl-value');
        return wrap;
    }

    setValue(v, notify = true) {
        // 吸附到步长
        const n = Math.round((v - this.min) / this.step);
        const snapped = this.min + n * this.step;
        this.value = Math.min(this.max, Math.max(this.min, snapped));
        this.input.value = String(this.value);
        this.valueEl.textContent = this.format(this.value);
        if (notify) this.onChange(this.value);
    }

    /** 语言切换时更新标签文字（不改数值） */
    setLabel(text) {
        this.labelEl.textContent = text;
    }

    get element() { return this.el; }
}

function min2(v) { return Number.isInteger(v) ? v : parseFloat(v.toFixed(6)); }

/** 复选框：对应上游 Checkbox */
export class Checkbox {
    constructor({ label, value = true, onChange = () => {} }) {
        this.value = value; this.onChange = onChange;
        const el = document.createElement('label');
        el.className = 'ctrl-check';
        el.innerHTML = `
            <input type="checkbox" />
            <span class="ctrl-check-box"></span>
            <span class="ctrl-check-label"></span>
        `;
        el.querySelector('.ctrl-check-label').textContent = label;
        const input = el.querySelector('input');
        input.checked = value;
        input.addEventListener('change', () => {
            this.value = input.checked;
            this.onChange(this.value);
        });
        this.input = input;
        this.labelEl = el.querySelector('.ctrl-check-label');
        this.el = el;
    }
    /** 语言切换时更新标签文字 */
    setLabel(text) { this.labelEl.textContent = text; }
    get element() { return this.el; }
}

/** 按钮：对应上游 Button */
export class Button {
    constructor({ label, onClick = () => {} }) {
        this.onClick = onClick;
        const el = document.createElement('button');
        el.className = 'ctrl-btn';
        el.textContent = label;
        el.addEventListener('click', () => this.onClick());
        this.el = el;
    }
    /** 语言切换时更新按钮文字 */
    setLabel(text) { this.el.textContent = text; }
    get element() { return this.el; }
}

/** 颜色滑块组：对应上游 ColorSliders（RGBA 四条） */
export class ColorSliders {
    constructor({ label = '颜色', value = '#3b82f6', onChange = () => {} }) {
        this.onChange = onChange;
        this.el = document.createElement('div');
        this.el.className = 'ctrl';
        this.el.innerHTML = `
            <div class="ctrl-head"><span class="ctrl-label">${label}</span>
            <span class="ctrl-value swatch"></span></div>
            <div class="ctrl-swatches"></div>
        `;
        const box = this.el.querySelector('.ctrl-swatches');
        // 预置一组适合学生理解的颜色
        const palette = [
            '#58C4DD', '#83C167', '#FFFF00', '#FC6255', '#403A34',
            '#0074D9', '#7FDBFF', '#39CCCC', '#3D9970', '#FF4136',
            '#2ECC40', '#FFDC00', '#FF851B', '#B10DC9', '#F012BE',
        ];
        for (const c of palette) {
            const b = document.createElement('button');
            b.className = 'swatch-btn';
            b.style.background = c;
            b.addEventListener('click', () => this.set(c, true));
            box.appendChild(b);
        }
        this.swatch = this.el.querySelector('.swatch');
    }
    set(hex, notify = false) {
        this.value = hex;
        this.swatch.style.background = hex;
        this.swatch.style.color = hex;
        if (notify) this.onChange(hex);
    }
    get element() { return this.el; }
}

/** 分组标题 */
export function sectionTitle(text) {
    const el = document.createElement('div');
    el.className = 'panel-section';
    el.textContent = text;
    return el;
}

/**
 * 画布交互：拖拽平移 + 滚轮缩放 + 双击复位。
 * 对应上游 InteractiveScene 的鼠标处理。
 */
export class CanvasController {
    constructor(canvas, { onChange = () => {} } = {}) {
        this.canvas = canvas;
        this.onChange = onChange;
        this.dragging = false;
        this.last = [0, 0];
        this.#bind();
    }

    #bind() {
        const c = this.canvas;
        c.addEventListener('pointerdown', (e) => {
            this.dragging = true;
            this.last = [e.clientX, e.clientY];
            c.setPointerCapture(e.pointerId);
        });
        c.addEventListener('pointermove', (e) => {
            if (!this.dragging) return;
            const dx = e.clientX - this.last[0];
            const dy = e.clientY - this.last[1];
            this.last = [e.clientX, e.clientY];
            this.onChange({ type: 'pan', dx, dy });
        });
        const stop = (e) => {
            if (!this.dragging) return;
            this.dragging = false;
            try { c.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        };
        c.addEventListener('pointerup', stop);
        c.addEventListener('pointercancel', stop);
        c.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.onChange({ type: 'zoom', delta: -e.deltaY * 0.0015, cx: e.clientX, cy: e.clientY });
        }, { passive: false });
        c.addEventListener('dblclick', () => this.onChange({ type: 'reset' }));
    }
}
