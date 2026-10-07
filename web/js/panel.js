/**
 * 参数面板通用渲染 —— 把模块声明的控件 schema 变成 DOM。
 *
 * schema 元素：
 *   { type: 'section', labelKey }                                  分组标题
 *   { type: 'group',   visible?(params, inst), children: [...] }    条件显示的一组控件
 *   { type: 'slider',  key, labelKey, min, max, step,
 *                      format?(v), round?(v), visible?(params, inst) }
 *
 * 值直接读写 inst.params[key]，因此语言切换 / 面板重建都不会丢状态。
 */

import { Slider, Checkbox, sectionTitle } from './controls.js';
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
    const groups = [];

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
            }
        }
    };

    add(container, schema);

    return {
        sliders,
        checks,
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
            for (const { desc, el } of groups) applyVis(el, desc);
        },
    };
}
