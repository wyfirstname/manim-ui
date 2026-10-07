/**
 * 相机 —— 对应上游 manimlib/camera/camera_frame.py
 *
 * 上游把相机做成一个 Mobject，因此相机运动与图形动画共用同一套系统。
 * 本相机提供「绕目标的球面轨道（theta/phi）+ 平移 + 缩放」，并生成上游
 * project_point.wgsl 所需的 view 矩阵与 frame_rescale_factors。
 *
 * ── 两个坐标系，别搞混 ──
 *   R^T 把世界点搬到**相机空间**：p_cam = R^T (p − center) / scale
 *   然后着色器做 scaled = p_cam * frame_rescale_factors，
 *   其中 frame_rescale_factors.z = scale / focal_distance 负责透视：
 *     w = 1 − scaled.z = d / focal_distance （d = 点到相机的距离）
 *   于是近的点 w 小 → NDC 大，这就是投影。z=0 的平面物体（2D 模块）
 *   拿到 w = 1，结果与不做透视完全一致。
 *
 * ── 视角参数 ──
 *   theta = 0, phi = 0 给出**恒等视角**（屏幕 x 即世界 x、屏幕 y 即世界 y），
 *   这正是所有 2D 模块依赖的默认值。theta 绕世界 Z 轴转，phi 是从 +Z 轴量起
 *   的极角：phi = 0 俯视，phi = 90° 平视。两者一起就是标准的轨道相机。
 *
 * 帧高约定与上游一致为 8.0 单位。
 */

import { FRAME_FIELDS, UniformBlock } from './uniform-block.js';

const DEG = Math.PI / 180;

export class Camera {
    constructor({ frameHeight = 8.0, width, height } = {}) {
        this.frameHeight = frameHeight;
        this.pixelWidth = width ?? 1;
        this.pixelHeight = height ?? 1;

        // 轨道目标与角度
        this.center = [0, 0, 0];
        this.theta = 0;   // 绕世界 Z 轴（方位角）
        this.phi = 0;     // 与 +Z 轴的夹角（极角）
        this.gamma = 0;   // 保留字段：本实现不使用
        this.zoom = 1;

        // 透视：关掉时 rescale.z 保持 1（与旧行为逐位一致），
        // 打开时 rescale.z = scale / focalDistance
        this.perspective = false;
        this.fovY = 45 * DEG;
        this.lightPosition = [-10, 10, 10];

        this.uniform = new UniformBlock(FRAME_FIELDS);
        this.uniform.setFloats('light_position', this.lightPosition);
    }

    resize(width, height) {
        this.pixelWidth = Math.max(1, width);
        this.pixelHeight = Math.max(1, height);
    }

    get frameWidth() {
        return this.frameHeight * (this.pixelWidth / this.pixelHeight);
    }

    /** 帧在场景单位下的高度：缩放越大，看到的世界越小 */
    get frameScale() {
        return 1 / Math.max(1e-6, this.zoom);
    }

    /** 焦距（世界单位）。等价于视野高度一半 / tan(半视角)。 */
    get focalDistance() {
        return 0.5 * this.frameHeight / Math.tan(this.fovY / 2);
    }

    /** 相机朝向：由目标指向相机的单位向量 */
    get direction() {
        const st = Math.sin(this.theta);
        const ct = Math.cos(this.theta);
        const sp = Math.sin(this.phi);
        const cp = Math.cos(this.phi);
        return [sp * st, -sp * ct, cp];
    }

    /** 相机所在位置（= 目标 + 焦距 · 朝向） */
    get position() {
        const d = this.perspective ? this.focalDistance : this.frameHeight / this.zoom;
        const dir = this.direction;
        return [
            this.center[0] + d * dir[0],
            this.center[1] + d * dir[1],
            this.center[2] + d * dir[2],
        ];
    }

    /**
     * 构造 view 矩阵（列主序 16 float，适配 WGSL mat4x4f）。
     *
     * 屏幕右 / 屏幕上 / 朝向 三个正交基：
     *   right = ( cosθ,  sinθ,  0)
     *   up    = (−cosφ sinθ,  cosφ cosθ,  sinφ)
     *   dir   = ( sinφ sinθ, −sinφ cosθ,  cosφ)
     * θ = φ = 0 时退化为单位阵，这就是 2D 模块用到的恒等视角。
     *
     * 最后按 1/scale 缩放：上游把「帧变小」的效果放在 view 里做，
     * frame_rescale_factors 保持常数，于是缩放与投影彻底解耦。
     */
    buildViewMatrix() {
        const st = Math.sin(this.theta);
        const ct = Math.cos(this.theta);
        const sp = Math.sin(this.phi);
        const cp = Math.cos(this.phi);

        const right = [ct, st, 0];
        const up = [-cp * st, cp * ct, sp];
        const dir = [sp * st, -sp * ct, cp];
        const c = this.center;
        const s = this.frameScale;

        const m = new Float32Array(16);
        m[0] = right[0] / s; m[1] = up[0] / s; m[2] = dir[0] / s; m[3] = 0;
        m[4] = right[1] / s; m[5] = up[1] / s; m[6] = dir[1] / s; m[7] = 0;
        m[8] = right[2] / s; m[9] = up[2] / s; m[10] = dir[2] / s; m[11] = 0;
        const dot = (v) => (v[0] * c[0] + v[1] * c[1] + v[2] * c[2]) / s;
        m[12] = -dot(right); m[13] = -dot(up); m[14] = -dot(dir); m[15] = 1;
        return m;
    }

    /** 更新帧级 uniform，返回可上传的 block。 */
    update() {
        this.uniform.setFloats('view', this.buildViewMatrix());
        // 帧宽高（场景单位）映射到 [-1,1]；缩放已由 view 承担，勿在此处再乘 zoom
        this.uniform.setFloats('frame_rescale_factors', [
            2 / this.frameWidth,
            2 / this.frameHeight,
            this.perspective ? this.frameScale / this.focalDistance : 1,
        ]);
        this.uniform.setFloats('frame_scale', this.frameScale);
        this.uniform.setFloats('camera_position', this.position);
        this.uniform.setFloats('pixel_size', this.frameHeight / this.pixelHeight);
        this.uniform.setFloats('light_position', this.lightPosition);
        return this.uniform;
    }

    /** 复位到恒等视角（2D 模块与每个模块装载预设时调用） */
    reset() {
        this.center = [0, 0, 0];
        this.theta = 0;
        this.phi = 0;
        this.gamma = 0;
        this.zoom = 1;
        return this;
    }

    /**
     * 屏幕坐标 -> 场景坐标（2D 用法：恒等视角下的帧平面）。
     */
    screenToScene(px, py) {
        const x = (px / this.pixelWidth - 0.5) * this.frameWidth / this.zoom;
        const y = -(py / this.pixelHeight - 0.5) * this.frameHeight / this.zoom;
        return [x, y, 0];
    }
}
