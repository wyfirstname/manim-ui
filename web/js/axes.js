/**
 * 坐标系工具 —— 函数绘图器与向量场流线共用
 *
 * 两个模块都要把「数学坐标」映射到「帧坐标」（is_fixed_in_frame = 1 时几何直接
 * 画在帧里，见 vmobject.js），也都要画网格 / 刻度 / 坐标轴、都要支持拖拽平移
 * 与以光标为锚点的滚轮缩放。这些逻辑与具体模块无关，故抽到这里。
 *
 * 参数对象约定（p）：
 *   centerX / centerY   视野中心的数学坐标
 *   xSpan  / ySpan      视野宽高（数学单位）
 */

/** 取一个「好看」的刻度步长（1/2/5 × 10^k） */
export function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    if (n >= 5) return 5 * mag;
    if (n >= 2) return 2 * mag;
    return mag;
}

/** 数学坐标 -> 帧坐标（z 由调用方补） */
export function toFrame(gpu, p, x, y) {
    const cam = gpu.camera;
    return [
        ((x - p.centerX) / p.xSpan) * cam.frameWidth,
        ((y - p.centerY) / p.ySpan) * cam.frameHeight,
    ];
}

/** 帧坐标 -> 数学坐标 */
export function toMath(gpu, p, fx, fy) {
    const cam = gpu.camera;
    return [
        (fx * p.xSpan) / cam.frameWidth + p.centerX,
        (fy * p.ySpan) / cam.frameHeight + p.centerY,
    ];
}

/** 屏幕坐标（clientX / clientY）-> 数学坐标 */
export function screenToMath(gpu, p, clientX, clientY) {
    const cam = gpu.camera;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = gpu.canvas.getBoundingClientRect();
    const u = (clientX - rect.left) * dpr;
    const v = (clientY - rect.top) * dpr;
    const ndcX = (u / gpu.width) * 2 - 1;
    const ndcY = 1 - (v / gpu.height) * 2;
    return toMath(gpu, p, (ndcX * cam.frameWidth) / 2, (ndcY * cam.frameHeight) / 2);
}

/** 默认配色（3b1b 深色主题） */
export const AXIS_COLORS = {
    grid: [0.30, 0.33, 0.38, 1],
    axis: [0.82, 0.85, 0.89, 1],
    tick: [0.62, 0.66, 0.71, 1],
};

/**
 * 网格 + 刻度 + 坐标轴，返回子路径数组（可直接交给 buildStrokeRecords）。
 * @param {object} colors { grid, axis, tick }
 */
export function buildAxes(gpu, p, colors = AXIS_COLORS) {
    const cam = gpu.camera;
    const fw = cam.frameWidth;
    const fh = cam.frameHeight;
    // 每个像素对应多少帧单位 —— 用来把刻度长度定成像素级
    const px = fh / Math.max(1, gpu.height);

    const x0 = p.centerX - p.xSpan / 2;
    const x1 = p.centerX + p.xSpan / 2;
    const y0 = p.centerY - p.ySpan / 2;
    const y1 = p.centerY + p.ySpan / 2;

    const subs = [];
    const [axisX, axisY] = toFrame(gpu, p, 0, 0);

    const xStep = niceStep(p.xSpan / 10);
    const yStep = niceStep(p.ySpan / 8);

    for (let x = Math.ceil(x0 / xStep) * xStep; x <= x1 + 1e-9; x += xStep) {
        const fx = toFrame(gpu, p, x, 0)[0];
        subs.push({ anchors: [[fx, -fh / 2, 0], [fx, fh / 2, 0]], width: 1, rgba: colors.grid });
    }
    for (let y = Math.ceil(y0 / yStep) * yStep; y <= y1 + 1e-9; y += yStep) {
        const fy = toFrame(gpu, p, 0, y)[1];
        subs.push({ anchors: [[-fw / 2, fy, 0], [fw / 2, fy, 0]], width: 1, rgba: colors.grid });
    }

    const tick = 5 * px;
    subs.push({ anchors: [[-fw / 2, axisY, 0], [fw / 2, axisY, 0]], width: 2.5, rgba: colors.axis });
    subs.push({ anchors: [[axisX, -fh / 2, 0], [axisX, fh / 2, 0]], width: 2.5, rgba: colors.axis });
    for (let x = Math.ceil(x0 / xStep) * xStep; x <= x1 + 1e-9; x += xStep) {
        const fx = toFrame(gpu, p, x, 0)[0];
        subs.push({ anchors: [[fx, axisY - tick, 0], [fx, axisY + tick, 0]], width: 1.5, rgba: colors.tick });
    }
    for (let y = Math.ceil(y0 / yStep) * yStep; y <= y1 + 1e-9; y += yStep) {
        const fy = toFrame(gpu, p, 0, y)[1];
        subs.push({ anchors: [[axisX - tick, fy, 0], [axisX + tick, fy, 0]], width: 1.5, rgba: colors.tick });
    }
    return subs;
}

/**
 * 平移 / 缩放 / 复位 —— 模块的 handleCanvasEvent 直接转调这里即可。
 *
 * 缩放以光标下的数学点为锚点（该点保持不动），这是看局部结构时最自然的手感。
 * 复位的目标值取模块「当前预设」里的 xSpan / ySpan / centerX / centerY。
 * 缩放下限可用 inst.minSpan 覆盖（默认 1）。
 *
 * @param {object} inst 模块实例（需有 params / preset / update()）
 * @param {object} e    画布事件 { type: 'pan'|'zoom'|'reset', ... }
 * @param {object} ctx  { gpu, canvas, invalidate, syncPanel }
 */
export function handlePanZoomReset(inst, e, ctx) {
    const p = inst.params;
    const cam = ctx.gpu.camera;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const minSpan = inst.minSpan ?? 1;

    if (e.type === 'pan') {
        // 屏幕像素 -> 帧单位 -> 数学单位
        const dfx = ((e.dx * dpr) / ctx.gpu.height) * cam.frameHeight;
        const dfy = ((e.dy * dpr) / ctx.gpu.height) * cam.frameHeight;
        p.centerX -= (dfx * p.xSpan) / cam.frameWidth;
        p.centerY += (dfy * p.ySpan) / cam.frameHeight;
        inst.update();
        ctx.invalidate?.();
        ctx.syncPanel?.();
    } else if (e.type === 'zoom') {
        const before = { xSpan: p.xSpan, ySpan: p.ySpan };
        const k = Math.min(4, Math.max(0.25, 1 + e.delta));
        const nx = Math.min(60, Math.max(minSpan, p.xSpan / k));
        const ny = Math.min(60, Math.max(minSpan, p.ySpan / k));
        if (nx === before.xSpan && ny === before.ySpan) return;

        // 让光标下的数学点保持不动
        const r = ctx.canvas.getBoundingClientRect();
        const cx = e.cx ?? (r.left + r.width / 2);
        const cy = e.cy ?? (r.top + r.height / 2);
        const [mx, my] = screenToMath(ctx.gpu, p, cx, cy);
        p.xSpan = nx;
        p.ySpan = ny;
        p.centerX = mx - (mx - p.centerX) * (nx / before.xSpan);
        p.centerY = my - (my - p.centerY) * (ny / before.ySpan);
        inst.update();
        ctx.invalidate?.();
        ctx.syncPanel?.();
    } else if (e.type === 'reset') {
        const d = inst.preset.params;
        p.xSpan = d.xSpan;
        p.ySpan = d.ySpan;
        p.centerX = d.centerX;
        p.centerY = d.centerY;
        inst.update();
        ctx.invalidate?.();
        ctx.syncPanel?.();
    }
}
