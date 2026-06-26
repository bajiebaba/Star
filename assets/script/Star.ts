import { _decorator, Component, Node, Vec3, v3 } from 'cc';

const { ccclass, property } = _decorator;

/** 可被星球引力影响的物体接口，避免 Star 与 Player 循环引用 */
export interface IGravitationTarget {
    node: Node;
    velocity: Vec3;
    bodyRadius: number;
    escapedStars: Set<Star>;
    /** 当前贴地附着的星球，null 表示在空中 */
    groundedStar: Star | null;
    /** 贴地收拢进度 [0,1]，0=刚触地，1=完全贴合并与地表共转 */
    groundSettleProgress: number;
    markEscaped(star: Star): void;
    clearEscape(star: Star): void;
    setGrounded(star: Star | null): void;
}

/**
 * 星球组件：描述一颗具有半径、质量、自转速度与引力影响范围的星球。
 *
 * 引力规则：
 * - 引力加速度大小与星球质量成正比（F ∝ M）
 * - 引力从地表到影响边界线性衰减，边界外不再施加引力
 * - 进入影响范围的物体会被拉向地表；径向速度足够大时可挣脱束缚
 * - 大气裹挟：随星球自转的「介质」将 Player 切向卷入共转，不影响径向坠落
 *   · 引力边界：裹挟强度 0，几乎不带动切向
 *   · 地表：裹挟强度 1，切向与地表完全同步（v = ω × r）
 *   · 中间：强度随距离线性增大
 * - 坠落过程中 Player 角度相对星球中心渐进回正（与裹挟强度共用 falloff）
 * - 贴地不切父节点：速度积分 + 投影到地表圆，切向与地表共转（与空中同一位移模型）
 */
@ccclass('Star')
export class Star extends Component {
    /** 场景中所有活跃星球，供 Player 自动注册使用 */
    private static _instances: Star[] = [];

    public static get instances(): readonly Star[] {
        return Star._instances;
    }

    /** 星球半径（从中心到地表的距离） */
    @property({ tooltip: '星球半径，从中心到地表的距离' })
    radius = 100;

    /** 星球质量，引力强度与之成正比 */
    @property({ tooltip: '星球质量，引力强度与之成正比' })
    mass = 1000;

    /** 自转速度，单位：度/秒，绕 Z 轴（2D 场景） */
    @property({ tooltip: '自转速度（度/秒），绕 Z 轴' })
    rotationSpeed = 30;

    /**
     * 引力影响范围：从地表向外延伸的最大距离。
     * 超出「半径 + 引力范围」后不再产生引力。
     */
    @property({ tooltip: '引力影响范围，从地表向外延伸的最大距离' })
    gravityRange = 500;

    /** 万有引力常数 G，用于调节整体引力强度 */
    @property({ tooltip: '万有引力常数 G，用于调节整体引力强度' })
    gravityConstant = 100;

    /** 判定「贴地」的距离容差（世界单位），用于接近地表的软收拢与裹挟加强 */
    @property({ tooltip: '接近地表软收拢的作用范围，越大越早开始往地表靠拢' })
    landingTolerance = 5;

    /** 触发着陆判定的距地表最大高度，应小于 landingTolerance，避免高空就 snap */
    @property({ tooltip: '允许判定着陆的距地表最大偏差，越小越晚触发着陆' })
    landingContactEpsilon = 1;

    /** 触地后收拢到地表圆的时长（秒） */
    @property({ tooltip: '触地后收拢到地表圆的过渡时长（秒）' })
    groundSettleDuration = 0.2;

    /** 朝外径向速度超过此值时视为离地，不再跟随自转 */
    @property({ tooltip: '朝外径向速度阈值，超过则视为跳跃/离地' })
    leaveRadialSpeed = 50;

    /** 大气裹挟系数：越大切向越快趋近该高度的共转线速度，不改变径向坠落 */
    @property({ formerlySerializedAs: 'atmosphereDrag', tooltip: '大气裹挟系数，越大越快被大气层带入星球自转' })
    atmosphereEntrainment = 4;

    /** 角度回正系数：坠落时越快对齐星球半径方向（与裹挟强度 falloff 联动） */
    @property({ tooltip: '角度回正系数，越大坠落时越快相对星球中心回正' })
    angleAlignStrength = 4;

    /** 接近地表时的软吸附强度（仅空中接近阶段） */
    @property({ tooltip: '接近地表时的软吸附强度，过大易有吸附感' })
    landingSoftPull = 5;

    /** 地表附近裹挟加强系数，着陆前切向更快与地表共转对齐 */
    @property({ tooltip: '地表附近裹挟加强，越大着陆前切向越快与地表同步' })
    surfaceEntrainmentBoost = 8;

    /** 当前受本星球引力影响的物体集合 */
    private _bodies = new Set<IGravitationTarget>();

    /** 星球中心的世界坐标（每帧从节点读取，避免缓存过期） */
    get center(): Vec3 {
        return this.node.worldPosition;
    }

    /** 引力影响的外边界距离（从中心算起） */
    get maxInfluenceDistance(): number {
        return this.radius + this.gravityRange;
    }

    onLoad() {
        Star._instances.push(this);
    }

    onDestroy() {
        const index = Star._instances.indexOf(this);
        if (index >= 0) {
            Star._instances.splice(index, 1);
        }
        this._bodies.clear();
    }

    /** 注册受引力影响的物体，由 Player 在 onEnable 时调用 */
    registerBody(body: IGravitationTarget) {
        this._bodies.add(body);
    }

    /** 注销物体，由 Player 在 onDisable 时调用 */
    unregisterBody(body: IGravitationTarget) {
        this._bodies.delete(body);
    }

    /**
     * 计算引力 / 自转影响的线性衰减系数，范围 [0, 1]。
     * - 地表（dist = radius）：1（满强度）
     * - 最远处（dist = radius + gravityRange）：0
     * - 中间线性插值
     */
    getInfluenceFalloff(distanceFromCenter: number): number {
        if (distanceFromCenter <= this.radius) {
            return 1;
        }
        if (distanceFromCenter >= this.maxInfluenceDistance) {
            return 0;
        }
        // 线性衰减：(边界距离 - 当前距离) / 影响范围宽度
        return (this.maxInfluenceDistance - distanceFromCenter) / this.gravityRange;
    }

    /**
     * 大气裹挟强度 [0, 1]，随与星球中心距离线性变化。
     *
     * 大气层随星球自转；该系数表示「被带入共转」的程度：
     * - 引力边界（dist = maxInfluenceDistance）：0，几乎不裹挟
     * - 地表（dist ≤ radius + bodyRadius）：1，切向与地表完全同步
     * - 中间：falloff = (maxDist - dist) / (maxDist - surfaceDist)
     */
    getEntrainmentFalloff(distanceFromCenter: number, bodyRadius = 0): number {
        const surfaceDist = this.radius + bodyRadius;
        const maxDist = this.maxInfluenceDistance;
        const span = maxDist - surfaceDist;

        if (distanceFromCenter <= surfaceDist) {
            return 1;
        }
        if (distanceFromCenter >= maxDist || span <= 0) {
            return 0;
        }
        return (maxDist - distanceFromCenter) / span;
    }

    /** 地表处与星球自转完全同步的切向线速度：v_surface = ω × r_surface */
    getSurfaceTangentialSpeed(bodyRadius = 0): number {
        const surfaceDist = this.radius + bodyRadius;
        const omega = this.rotationSpeed * Math.PI / 180;
        return omega * surfaceDist;
    }

    /**
     * 当前高度处大气介质的共转切向线速度（标量，逆时针为正）。
     *
     * v_t(r) = entrainment(r) × v_surface
     * 从引力边界 0 到地表 v_surface，裹挟强度随距离严格线性。
     */
    getEntrainedTangentialSpeed(distanceFromCenter: number, bodyRadius = 0): number {
        return this.getEntrainmentFalloff(distanceFromCenter, bodyRadius)
            * this.getSurfaceTangentialSpeed(bodyRadius);
    }

    /** @deprecated 使用 getEntrainmentFalloff */
    getTangentialFalloff(distanceFromCenter: number, bodyRadius = 0): number {
        return this.getEntrainmentFalloff(distanceFromCenter, bodyRadius);
    }

    /** @deprecated 使用 getEntrainedTangentialSpeed */
    getTargetTangentialSpeed(distanceFromCenter: number, bodyRadius = 0): number {
        return this.getEntrainedTangentialSpeed(distanceFromCenter, bodyRadius);
    }

    /** @deprecated 使用 getEntrainmentFalloff */
    getRotationFalloff(distanceFromCenter: number, bodyRadius = 0): number {
        return this.getTangentialFalloff(distanceFromCenter, bodyRadius);
    }

    /**
     * 约束在引力球内：硬边界 + 下落时禁止切向把半径撑大。
     * @returns 是否触碰到引力边界
     */
    constrainToGravitySphere(
        prevDist: number,
        worldPos: Vec3,
        velocity: Vec3,
        bodyRadius: number,
    ): boolean {
        const dx = worldPos.x - this.center.x;
        const dy = worldPos.y - this.center.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        const maxDist = this.maxInfluenceDistance;

        if (dist < 1e-6) {
            return false;
        }

        let invDist = 1 / dist;
        let outwardX = dx * invDist;
        let outwardY = dy * invDist;
        let radialSpeed = velocity.x * outwardX + velocity.y * outwardY;
        let hitBoundary = false;

        // 硬边界：超出引力范围则压回边界并消去朝外径向速度
        if (dist > maxDist) {
            outwardX = dx * invDist;
            outwardY = dy * invDist;
            worldPos.set(
                this.center.x + outwardX * maxDist,
                this.center.y + outwardY * maxDist,
                worldPos.z,
            );
            radialSpeed = velocity.x * outwardX + velocity.y * outwardY;
            if (radialSpeed > 0) {
                velocity.set(0, 0, velocity.z);
            } else {
                velocity.set(outwardX * radialSpeed, outwardY * radialSpeed, velocity.z);
            }
            hitBoundary = true;
            dist = maxDist;
        }

        // 下落中（非主动跳起）：稳定约束，防止裹挟切向把半径撑大（非裹挟本身）
        if (dist > prevDist + 0.01 && radialSpeed <= this.leaveRadialSpeed) {
            worldPos.set(
                this.center.x + outwardX * prevDist,
                this.center.y + outwardY * prevDist,
                worldPos.z,
            );
            const tangentX = -outwardY;
            const tangentY = outwardX;
            const tanSpeed = velocity.x * tangentX + velocity.y * tangentY;
            velocity.set(
                outwardX * radialSpeed + tangentX * tanSpeed * 0.5,
                outwardY * radialSpeed + tangentY * tanSpeed * 0.5,
                velocity.z,
            );
        }

        return hitBoundary;
    }

    /**
     * 大气裹挟：将 Player 切向速度渐进拉向当前高度的共转线速度 v_t(r)。
     *
     * 只改切向、不改径向——不是阻力，而是被随星球自转的大气层「带着转」。
     * 裹挟强度由 getEntrainmentFalloff 决定：远处弱、地表最强。
     *
     * 仅在向心下落时生效（远离星球时不裹挟）。
     * 高空另有稳定约束：切向不得超过 |径向|，避免被甩出引力球（见 constrainToGravitySphere）。
     */
    applyAtmosphericEntrainment(
        velocity: Vec3,
        worldPos: Vec3,
        bodyRadius: number,
        deltaTime: number,
    ) {
        const dx = worldPos.x - this.center.x;
        const dy = worldPos.y - this.center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 1e-6 || dist > this.maxInfluenceDistance) {
            return;
        }

        const entrainment = this.getEntrainmentFalloff(dist, bodyRadius);
        if (entrainment <= 0) {
            return;
        }

        const invDist = 1 / dist;
        const outwardX = dx * invDist;
        const outwardY = dy * invDist;
        const tangentX = -dy * invDist;
        const tangentY = dx * invDist;

        const radialSpeed = velocity.x * outwardX + velocity.y * outwardY;

        // 仅在向心下落时被大气裹挟；远离星球时不施加
        if (radialSpeed >= 0) {
            return;
        }

        const currentTanSpeed = velocity.x * tangentX + velocity.y * tangentY;
        const surfaceDist = this.radius + bodyRadius;
        const nearSurface = dist <= surfaceDist + this.landingTolerance;
        let targetTanSpeed = this.getEntrainedTangentialSpeed(dist, bodyRadius);

        // 高空稳定约束：切向变化率受径向限制，防止被甩出
        // 地表附近：解除限制，切向目标为完整地表共转，便于着陆无缝衔接
        if (nearSurface) {
            targetTanSpeed = this.getSurfaceTangentialSpeed(bodyRadius);
        } else {
            targetTanSpeed = Math.min(targetTanSpeed, Math.abs(radialSpeed));
        }

        const blend = nearSurface
            ? Math.min(1, this.surfaceEntrainmentBoost * deltaTime)
            : Math.min(1, this.atmosphereEntrainment * entrainment * deltaTime);
        const newTanSpeed = currentTanSpeed + (targetTanSpeed - currentTanSpeed) * blend;

        velocity.set(
            outwardX * radialSpeed + tangentX * newTanSpeed,
            outwardY * radialSpeed + tangentY * newTanSpeed,
            velocity.z,
        );
    }

    /** @deprecated 使用 applyAtmosphericEntrainment */
    applyAtmosphericDrag(
        velocity: Vec3,
        worldPos: Vec3,
        bodyRadius: number,
        deltaTime: number,
    ) {
        this.applyAtmosphericEntrainment(velocity, worldPos, bodyRadius, deltaTime);
    }

    /**
     * 相对星球中心「回正」的目标角度（度）。
     * 使 Player 的 +Y 轴沿半径朝外，与地表法线一致。
     */
    getSurfaceNormalAngle(offsetX: number, offsetY: number): number {
        return Math.atan2(offsetY, offsetX) * 180 / Math.PI - 90;
    }

    /** 角度插值，走最短弧 */
    lerpAngle(from: number, to: number, t: number): number {
        let diff = to - from;
        while (diff > 180) {
            diff -= 360;
        }
        while (diff < -180) {
            diff += 360;
        }
        return from + diff * t;
    }

    /**
     * 坠落过程中渐进回正角度：引力边界不校正，地表完全对齐法线，中间随裹挟强度线性增强。
     * 只改 node.angle，不影响位移。
     */
    applyAngleAlignment(
        body: IGravitationTarget,
        worldPos: Vec3,
        bodyRadius: number,
        deltaTime: number,
    ) {
        const dx = worldPos.x - this.center.x;
        const dy = worldPos.y - this.center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 1e-6 || dist > this.maxInfluenceDistance) {
            return;
        }

        const entrainment = this.getEntrainmentFalloff(dist, bodyRadius);
        if (entrainment <= 0) {
            return;
        }

        const targetAngle = this.getSurfaceNormalAngle(dx, dy);
        const blend = Math.min(1, this.angleAlignStrength * entrainment * deltaTime);
        body.node.angle = this.lerpAngle(body.node.angle, targetAngle, blend);
    }

    /**
     * 对齐 Player 朝向与地表法线（+Y 沿半径朝外）。
     * - 收拢中：随 groundSettleProgress 渐进，结束时 eased=1 精确回正
     * - 已贴定：每帧严格等于法线角，随地表共转保持回正
     */
    applySurfaceAngleAlignment(
        body: IGravitationTarget,
        offsetX: number,
        offsetY: number,
        settled: boolean,
        settleEased: number,
    ) {
        const targetAngle = this.getSurfaceNormalAngle(offsetX, offsetY);
        if (settled) {
            body.node.angle = targetAngle;
        } else {
            body.node.angle = this.lerpAngle(body.node.angle, targetAngle, settleEased);
        }
    }

    /** 若 Player 仍挂在 Star 下（旧逻辑遗留），还原到 Star 的父节点，保持世界坐标 */
    detachLegacyStarParent(body: IGravitationTarget) {
        if (body.node.parent !== this.node) {
            return;
        }
        const parent = this.node.parent;
        if (parent) {
            body.node.setParent(parent, true);
        }
    }

    /**
     * 计算指定世界坐标处的引力加速度（方向指向星球中心）。
     * 影响范围外返回零向量。
     *
     * a = G * M / r² * falloff(r)
     */
    computeGravityAcceleration(worldPos: Vec3, out?: Vec3): Vec3 {
        const result = out ?? v3();
        const offset = Vec3.subtract(v3(), worldPos, this.center);
        const dist = offset.length();

        if (dist < 1e-6 || dist > this.maxInfluenceDistance) {
            return result.set(0, 0, 0);
        }

        const falloff = this.getInfluenceFalloff(dist);
        const accelMag = (this.gravityConstant * this.mass * falloff) / (dist * dist);

        // offset 由中心指向物体，引力方向相反
        return offset.normalize().multiplyScalar(-accelMag);
    }

    /**
     * 计算从指定距离挣脱引力所需的最小径向速度（逃逸速度）。
     *
     * 由能量守恒推导：v² = 2 ∫[r → maxDist] a(x) dx
     * 其中 a(x) = G*M/x² * falloff(x)，falloff 为线性衰减。
     */
    getEscapeVelocity(distanceFromCenter: number): number {
        if (distanceFromCenter >= this.maxInfluenceDistance) {
            return 0;
        }
        if (distanceFromCenter <= this.radius) {
            distanceFromCenter = this.radius;
        }

        const G = this.gravityConstant;
        const M = this.mass;
        const maxDist = this.maxInfluenceDistance;
        const range = this.gravityRange;
        const r = distanceFromCenter;

        // ∫ (maxDist - x)/x² dx = -maxDist/x - ln(x)
        const potentialIntegral = (x: number) => -maxDist / x - Math.log(x);
        const deltaU = potentialIntegral(r) - potentialIntegral(maxDist);

        const vSquared = (2 * G * M / range) * deltaU;
        return vSquared > 0 ? Math.sqrt(vSquared) : 0;
    }

    /**
     * 判断物体是否已挣脱该星球的引力束缚。
     * 条件：超出影响边界，且径向速度朝外且不低于逃逸速度。
     */
    isEscaped(worldPos: Vec3, velocity: Vec3): boolean {
        const offset = Vec3.subtract(v3(), worldPos, this.center);
        const dist = offset.length();

        if (dist <= this.maxInfluenceDistance) {
            return false;
        }

        const outward = offset.normalize();
        const radialSpeed = Vec3.dot(velocity, outward);
        return radialSpeed > 0;
    }

    /**
     * 将物体约束在星球表面：若陷入地下则弹出到地表，并消去指向地心的径向速度。
     * @returns 是否接触或位于地表
     */
    constrainToSurface(worldPos: Vec3, velocity: Vec3, bodyRadius = 0): boolean {
        const offset = Vec3.subtract(v3(), worldPos, this.center);
        const dist = offset.length();
        const surfaceDist = this.radius + bodyRadius;

        if (dist >= surfaceDist) {
            return false;
        }

        // 投影到地表
        const surfaceDir = dist > 1e-6 ? offset.normalize() : v3(0, 1, 0);
        worldPos.set(
            this.center.x + surfaceDir.x * surfaceDist,
            this.center.y + surfaceDir.y * surfaceDist,
            this.center.z + surfaceDir.z * surfaceDist,
        );

        // 保留切向速度，去除指向地心的径向分量
        const radialSpeed = Vec3.dot(velocity, surfaceDir);
        if (radialSpeed < 0) {
            velocity.x -= surfaceDir.x * radialSpeed;
            velocity.y -= surfaceDir.y * radialSpeed;
            velocity.z -= surfaceDir.z * radialSpeed;
        }

        return true;
    }

    /**
     * 是否应判定为着陆：距地表在 landingContactEpsilon 内，且没有足够大的朝外径向速度。
     * landingTolerance 仅用于软收拢，着陆本身要求更贴近地表，避免 snap 吸附。
     */
    shouldLand(worldPos: Vec3, velocity: Vec3, bodyRadius = 0): boolean {
        const offset = Vec3.subtract(v3(), worldPos, this.center);
        const dist = offset.length();
        const surfaceDist = this.radius + bodyRadius;

        if (dist > surfaceDist + this.landingContactEpsilon) {
            return false;
        }

        if (dist < 1e-6) {
            return true;
        }

        const outwardX = offset.x / dist;
        const outwardY = offset.y / dist;
        const radialSpeed = velocity.x * outwardX + velocity.y * outwardY;
        return radialSpeed <= this.leaveRadialSpeed;
    }

    /** 将世界坐标投影到地表圆上（精确半径，消除浮点漂移） */
    snapToSurface(worldPos: Vec3, bodyRadius: number, out?: Vec3): Vec3 {
        const result = out ?? v3();
        const surfaceDist = this.radius + bodyRadius;
        const dx = worldPos.x - this.center.x;
        const dy = worldPos.y - this.center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 1e-6) {
            return result.set(this.center.x, this.center.y + surfaceDist, worldPos.z);
        }

        const scale = surfaceDist / dist;
        return result.set(
            this.center.x + dx * scale,
            this.center.y + dy * scale,
            worldPos.z,
        );
    }

    /** 设置与星球自转一致的切向速度（径向归零，切向 = ω × r_surface） */
    setGroundedVelocity(velocity: Vec3, worldPos: Vec3, bodyRadius: number) {
        const dx = worldPos.x - this.center.x;
        const dy = worldPos.y - this.center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 1e-6) {
            velocity.set(0, 0, velocity.z);
            return;
        }

        const invDist = 1 / dist;
        const tangentX = -dy * invDist;
        const tangentY = dx * invDist;
        // 贴地 / 着陆：切向线速度始终与地表共转一致
        const tanSpeed = this.getSurfaceTangentialSpeed(bodyRadius);

        velocity.set(tangentX * tanSpeed, tangentY * tanSpeed, velocity.z);
    }

    /** smoothstep 缓动 */
    smoothstep(t: number): number {
        const x = Math.max(0, Math.min(1, t));
        return x * x * (3 - 2 * x);
    }

    /**
     * 将速度向共转切向速度混合，同时衰减径向分量（用于地表附近裹挟 / 着陆衔接）。
     * @param blend [0,1] 裹挟混合系数
     */
    blendEntrainmentVelocity(
        velocity: Vec3,
        worldPos: Vec3,
        bodyRadius: number,
        blend: number,
    ) {
        const dx = worldPos.x - this.center.x;
        const dy = worldPos.y - this.center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 1e-6) {
            velocity.set(0, 0, velocity.z);
            return;
        }

        const invDist = 1 / dist;
        const outwardX = dx * invDist;
        const outwardY = dy * invDist;
        const tangentX = -dy * invDist;
        const tangentY = dx * invDist;

        const radialSpeed = velocity.x * outwardX + velocity.y * outwardY;
        const tanSpeed = velocity.x * tangentX + velocity.y * tangentY;
        const targetTan = this.getSurfaceTangentialSpeed(bodyRadius);

        const newRadial = radialSpeed * (1 - blend);
        const newTan = tanSpeed + (targetTan - tanSpeed) * blend;

        velocity.set(
            outwardX * newRadial + tangentX * newTan,
            outwardY * newRadial + tangentY * newTan,
            velocity.z,
        );
    }

    /** @deprecated 使用 blendEntrainmentVelocity */
    blendVelocityToGrounded(
        velocity: Vec3,
        worldPos: Vec3,
        bodyRadius: number,
        blend: number,
    ) {
        this.blendEntrainmentVelocity(velocity, worldPos, bodyRadius, blend);
    }

    /**
     * 接近地表：位置软拉向地表圆，切向速度按地表裹挟强度向共转线速度收敛。
     * 着陆判定时切向应已与地表基本一致。
     */
    applySoftSurfaceApproach(
        worldPos: Vec3,
        velocity: Vec3,
        bodyRadius: number,
        deltaTime: number,
    ) {
        const surfaceDist = this.radius + bodyRadius;
        const dx = worldPos.x - this.center.x;
        const dy = worldPos.y - this.center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist >= surfaceDist + this.landingTolerance) {
            return;
        }

        const surfacePos = this.snapToSurface(worldPos, bodyRadius, v3());
        const proximity = 1 - Math.max(0, dist - surfaceDist) / this.landingTolerance;
        const eased = this.smoothstep(proximity);
        const pull = Math.min(1, this.landingSoftPull * deltaTime * eased);
        worldPos.x += (surfacePos.x - worldPos.x) * pull;
        worldPos.y += (surfacePos.y - worldPos.y) * pull;

        // 用地表投影点计算切向，越接近地表 blend 越大
        const syncPos = this.snapToSurface(worldPos, bodyRadius, v3());
        const velBlend = Math.min(1, this.surfaceEntrainmentBoost * deltaTime * eased);
        this.blendEntrainmentVelocity(velocity, syncPos, bodyRadius, velBlend);
    }

    /** 贴地状态下是否应离地（仅看朝外径向速度，切向速度不触发） */
    shouldLeaveGround(body: IGravitationTarget): boolean {
        const pos = body.node.worldPosition;
        const offset = Vec3.subtract(v3(), pos, this.center);
        const dist = offset.length();
        if (dist < 1e-6) {
            return false;
        }

        const radialSpeed = (body.velocity.x * offset.x + body.velocity.y * offset.y) / dist;
        return radialSpeed > this.leaveRadialSpeed;
    }

    /**
     * 贴地更新：与空中相同的速度积分驱动位移，仅额外软投影到地表圆。
     * 触地帧不再切换运动模型，避免 defer / 旋转 snap 造成卡顿。
     */
    updateGrounded(body: IGravitationTarget, deltaTime: number) {
        const justLanded = body.groundSettleProgress < 1e-6;

        const duration = Math.max(0.01, this.groundSettleDuration);
        if (body.groundSettleProgress < 1) {
            body.groundSettleProgress = Math.min(1, body.groundSettleProgress + deltaTime / duration);
        }
        const eased = this.smoothstep(body.groundSettleProgress);
        const settled = body.groundSettleProgress >= 1;

        const pos = body.node.worldPosition.clone();
        const vel = body.velocity;
        const cx = this.center.x;
        const cy = this.center.y;
        const surfaceDist = this.radius + body.bodyRadius;

        if (settled) {
            this.setGroundedVelocity(vel, pos, body.bodyRadius);
        } else {
            this.blendEntrainmentVelocity(vel, pos, body.bodyRadius, eased);
        }

        // 触地帧已在空中物理中完成一次积分，此处不再重复积分
        const newPos = justLanded
            ? pos
            : v3(
                pos.x + vel.x * deltaTime,
                pos.y + vel.y * deltaTime,
                pos.z + vel.z * deltaTime,
            );

        const dx = newPos.x - cx;
        const dy = newPos.y - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > 1e-6) {
            const targetDist = settled ? surfaceDist : dist + (surfaceDist - dist) * eased;
            newPos.set(
                cx + dx / dist * targetDist,
                cy + dy / dist * targetDist,
                newPos.z,
            );
        } else {
            newPos.set(cx, cy + surfaceDist, newPos.z);
        }

        body.node.setWorldPosition(newPos);

        const odx = newPos.x - cx;
        const ody = newPos.y - cy;
        this.applySurfaceAngleAlignment(body, odx, ody, settled, eased);

        if (settled) {
            this.setGroundedVelocity(vel, newPos, body.bodyRadius);
        }
    }

    update(deltaTime: number) {
        // ① 清理旧版「挂为 Star 子节点」的遗留父级
        for (const body of this._bodies) {
            if (!body.node.activeInHierarchy) {
                continue;
            }
            this.detachLegacyStarParent(body);
        }

        // ② 空中物理（星球尚未自转）
        for (const body of this._bodies) {
            if (!body.node.activeInHierarchy) {
                continue;
            }

            const pos = body.node.worldPosition.clone();
            const vel = body.velocity;
            const distToCenter = Vec3.distance(pos, this.center);

            if (distToCenter > this.maxInfluenceDistance) {
                this.constrainToGravitySphere(distToCenter, pos, vel, body.bodyRadius);
                body.node.setWorldPosition(pos);
                continue;
            }

            // 贴地：判定跳起则解除贴地，本帧走空中物理
            if (body.groundedStar === this) {
                if (!this.shouldLeaveGround(body)) {
                    continue;
                }
                body.setGrounded(null);
            }

            const accel = this.computeGravityAcceleration(pos);
            vel.x += accel.x * deltaTime;
            vel.y += accel.y * deltaTime;
            vel.z += accel.z * deltaTime;

            this.applyAtmosphericEntrainment(vel, pos, body.bodyRadius, deltaTime);

            const newPos = v3(
                pos.x + vel.x * deltaTime,
                pos.y + vel.y * deltaTime,
                pos.z + vel.z * deltaTime,
            );

            this.constrainToGravitySphere(distToCenter, newPos, vel, body.bodyRadius);
            this.applySoftSurfaceApproach(newPos, vel, body.bodyRadius, deltaTime);

            if (this.shouldLand(newPos, vel, body.bodyRadius)) {
                body.node.setWorldPosition(newPos);
                // 触地帧继续按空中逻辑回正角度，与贴地收拢衔接，避免角度突变
                this.applyAngleAlignment(body, newPos, body.bodyRadius, deltaTime);
                body.setGrounded(this);
                continue;
            }

            body.node.setWorldPosition(newPos);
            this.applyAngleAlignment(body, newPos, body.bodyRadius, deltaTime);
        }

        // ③ 星球自转
        this.node.angle += this.rotationSpeed * deltaTime;

        // ④ 贴地：速度积分 + 地表投影（与空中同一套位移逻辑）
        for (const body of this._bodies) {
            if (!body.node.activeInHierarchy) {
                continue;
            }
            if (body.groundedStar === this) {
                this.updateGrounded(body, deltaTime);
            }
        }
    }
}
