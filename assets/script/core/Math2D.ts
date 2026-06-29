import { Vec2 } from 'cc';

/** 2D 物理运算工具（逻辑坐标，单位：像素） */
export class Math2D {
    /** 钳制 dt，防止切后台后物理爆炸 */
    static clampDt(dt: number, max = 0.05): number {
        return dt > max ? max : dt;
    }

    static lenSq(v: Vec2): number {
        return v.x * v.x + v.y * v.y;
    }

    static len(v: Vec2): number {
        return Math.sqrt(this.lenSq(v));
    }

    static distSq(a: Vec2, b: Vec2): number {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        return dx * dx + dy * dy;
    }

    static dist(a: Vec2, b: Vec2): number {
        return Math.sqrt(this.distSq(a, b));
    }

    /** 单位向量；长度过小时返回 fallback */
    static normalize(v: Vec2, out: Vec2, fallback?: Vec2): Vec2 {
        const l = this.len(v);
        if (l < 1e-6) {
            if (fallback) {
                out.set(fallback);
            } else {
                out.set(1, 0);
            }
            return out;
        }
        out.set(v.x / l, v.y / l);
        return out;
    }

    /** 将 v 分解为径向（沿 radialUnit）与切向分量 */
    static decomposeRadial(v: Vec2, radialUnit: Vec2, radial: Vec2, tangential: Vec2): void {
        const vr = v.x * radialUnit.x + v.y * radialUnit.y;
        radial.set(radialUnit.x * vr, radialUnit.y * vr);
        tangential.set(v.x - radial.x, v.y - radial.y);
    }

    /** 垂直于 radial 的单位向量（逆时针 90°） */
    static perpendicularCCW(radial: Vec2, out: Vec2): Vec2 {
        out.set(-radial.y, radial.x);
        return out;
    }

    /** 线性插值 */
    static lerp(a: Vec2, b: Vec2, t: number, out: Vec2): Vec2 {
        out.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
        return out;
    }

    /** 平滑阻尼（用于相机等） */
    static smoothDamp(
        current: number,
        target: number,
        currentVelocity: { value: number },
        smoothTime: number,
        dt: number,
        maxSpeed = Infinity,
    ): number {
        smoothTime = Math.max(0.0001, smoothTime);
        const omega = 2 / smoothTime;
        const x = omega * dt;
        const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
        let change = current - target;
        const maxChange = maxSpeed * smoothTime;
        change = Math.max(-maxChange, Math.min(change, maxChange));
        const temp = (currentVelocity.value + omega * change) * dt;
        currentVelocity.value = (currentVelocity.value - omega * temp) * exp;
        return target + (change + temp) * exp;
    }

    /** 两角度最短差值（度），结果 ∈ (−180, 180] */
    static deltaAngleDeg(from: number, to: number): number {
        let delta = (to - from) % 360;
        if (delta > 180) {
            delta -= 360;
        }
        if (delta <= -180) {
            delta += 360;
        }
        return delta;
    }

    /** 沿最短弧插值角度（度） */
    static lerpAngleDeg(from: number, to: number, t: number): number {
        return from + this.deltaAngleDeg(from, to) * t;
    }

    /** 角度平滑阻尼：捕获/引力弯折时船头渐进转向，避免瞬间跳变 */
    static smoothDampAngle(
        current: number,
        target: number,
        currentVelocity: { value: number },
        smoothTime: number,
        dt: number,
        maxSpeed = Infinity,
    ): number {
        const wrappedTarget = current + this.deltaAngleDeg(current, target);
        return this.smoothDamp(current, wrappedTarget, currentVelocity, smoothTime, dt, maxSpeed);
    }
}
