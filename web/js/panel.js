/**
 * 参数面板通用渲染 —— 把模块声明的控件 schema 变成 DOM。
 *
 * schema 元素：
 *   { type: 'section', labelKey }                                  分组标题
 *   { type: 'group',   visible?(params, inst), children: [...] }    条件显示的一组控件
 *   { type: 'slider',  key, labelKey, min, max, step,
 *                      format?(v), round?(v), visible?(params, inst) }
 *   { type: 'check',   key, labelKey, visible? }
 *   { type: 'text',    key, labelKey, placeholder?, hintKey?, visible? }
 *
 * 值直接读写 inst.params[key]，因此语言切换 / 面板重建都不会丢状态。
 *
 * 错误提示约定：模块可以把「某个参数哪里不对」写进 `inst.paramsError[key]`，
 * 内容形如 `{ code, args }`（例如表达式解析器的错误），面板负责翻成人话显示。
 */

import { Slider, Checkbox, TextInput, sectionTitle } from './controls.js';
import { t } from './i18n.js';

/**
 * @param {HTMLElement} container 面板容器（会被清空）
 * @param {Array} schema 控件描述
 * @param {object} inst 模块实例（提供 params）
 * @param {(key: string) => void} [onChange] 任一控件变化时回调
 * @returns {{ controls: Array, getSlider: (key: string) => Slider|null, sync: () => void }}
 */
export function buildPanel(container, schema, inst, onChange) {
    container.innerHTML = '';
    const sliders = [];
    const checks = [];
    const texts = [];
    const groups = [];

    /** inst.paramsError 里的 { code, args } → 界面文案 */
    const showError = (key) => {
        const e = inst.paramsError?.[key];
        if (!e) return '';
        return t(`expr.err.${e.code}`, e.args ?? {});
    };

    const add = (parent, list) => {
        for (const item of list ?? []) {
            if (item.type === 'section') {
                parent.appendChild(sectionTitle(t(item.labelKey)));
            } else if (item.type === 'group') {
                const el = document.createElement('div');
                add(el, item.children);
                parent.appendChild(el);
                groups.push({ desc: item, el });
            } else if (item.type === 'slider') {
                const slider = new Slider({
                    label: t(item.labelKey),
                    min: item.min,
                    max: item.max,
                    step: item.step,
                    value: inst.params[item.key] ?? item.min,
                    format: item.format ?? ((v) => v.toFixed(2)),
                    onChange: (v) => {
                        inst.params[item.key] = item.round ? item.round(v) : v;
                        onChange?.(item.key);
                    },
                });
                parent.appendChild(slider.element);
                sliders.push({ desc: item, slider });
            } else if (item.type === 'check') {
                const check = new Checkbox({
                    label: t(item.labelKey),
                    value: !!inst.params[item.key],
                    onChange: (v) => {
                        inst.params[item.key] = v;
                        onChange?.(item.key);
                    },
                });
                parent.appendChild(check.element);
                checks.push({ desc: item, check });
            } else if (item.type === 'text') {
                const text = new TextInput({
                    label: t(item.labelKey),
                    value: inst.params[item.key] ?? '',
                    placeholder: item.placeholder ?? '',
                    hint: item.hintKey ? t(item.hintKey) : '',
                    onChange: (v) => {
                        inst.params[item.key] = v;
                        onChange?.(item.key);
                        // 模块在 update() 里把解析结果写进 paramsError，这里立刻反映出来
                        text.setError(showError(item.key));
                    },
                });
                text.setError(showError(item.key));
                parent.appendChild(text.element);
                texts.push({ desc: item, text });
            }
        }
    };

    add(container, schema);

    return {
        sliders,
        checks,
        texts,
        getSlider(key) {
            return sliders.find((s) => s.desc.key === key)?.slider ?? null;
        },
        /** 用 inst.params 回填全部控件，并按 visible 谓词决定显隐 */
        sync() {
            const applyVis = (el, desc) => {
                const vis = desc.visible ? desc.visible(inst.params, inst) : true;
                el.style.display = vis ? '' : 'none';
            };
            for (const { desc, slider } of sliders) {
                const v = inst.params[desc.key];
                if (typeof v === 'number') slider.setValue(v, false);
                applyVis(slider.element, desc);
            }
            for (const { desc, check } of checks) {
                check.input.checked = !!inst.params[desc.key];
                applyVis(check.element, desc);
            }
            for (const { desc, text } of texts) {
                text.setValue(inst.params[desc.key]);
                text.setError(showError(desc.key));
                applyVis(text.element, desc);
            }
            for (const { desc, el } of groups) applyVis(el, desc);
        },
    };
}
