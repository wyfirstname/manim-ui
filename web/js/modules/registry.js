/**
 * 模块注册表
 *
 * 新增一个模块的完整步骤：
 *   1. 在 web/js/modules/ 下写一个模块文件，导出描述符：
 *        { id, nameKey, presets, panel, create(gpu) }
 *   2. 在这里 import 并加进 MODULES 数组（顺序即侧栏顺序）
 *   3. 在 web/js/i18n.js 的 zh / en 两份词表里补上模块名与预设词条
 * 不需要改动 app.js。
 */

import { fractalModule } from './fractal.js';
import { plotModule } from './plot.js';
import { fieldModule } from './field.js';
import { solidModule } from './solid.js';
import { randomModule } from './random.js';
import { fourierModule } from './fourier.js';
import { matrixModule } from './matrix.js';
import { distModule } from './dist.js';

/** 按侧栏显示顺序注册 */
export const MODULES = [
    fractalModule,
    plotModule,
    fieldModule,
    solidModule,
    randomModule,
    fourierModule,
    matrixModule,
    distModule,
];

export function getModule(id) {
    return MODULES.find((m) => m.id === id) ?? MODULES[0];
}
