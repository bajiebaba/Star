import { Vec2, v2 } from 'cc';
import { Math2D } from './core/Math2D';
import { Player, FlightMode } from './Player';
import { Star } from './Star';

/** 物理步频率：120Hz，与渲染帧解耦以保证轨迹丝滑 */
export const PHYSICS_HZ = 120;
export const FIXED_DT = 1 / PHYSICS_HZ;
export const MAX_PHYSICS_STEPS = 4;

/** 引力 softening，防止 r→0 时加速度发散 */
export const GRAVITY_SOFTENING = 40;

/** 惯性飞行：引力加强 + softening 减弱，掠过时可感知弯折 */
const FREE_FLIGHT_GRAVITY_BOOST = 1.75;
const FREE_FLIGHT_SOFTEN_SCALE = 0.48;
/** 掠过捕获：本帧轨迹最近点进入此比例 gravityRange 内即可软捕获 */
const GRAZE_CAPTURE_RANGE_RATIO = 0.82;
/** 在引力井内持续此时间且非强逃逸 → 辅助捕获 */
const GRAV_WELL_CAPTURE_DWELL = 0.08;

/**
 * 统一 N 体引力物理管理器。
 * 负责：固定步积分、软捕获入轨、逃逸判定、渲染插值 alpha。
 */
export class PhysicsManager {
    private _stars: Star[] = [];
    private _player: Player | null = null;
    private _accumulator = 0;
    /** 当前帧渲染插值系数 [0,1) */
    private _alpha = 0;

    private readonly _tmpDir = v2();
    private readonly _tmpRadial = v2();
    private readonly _tmpTangential = v2();
    private readonly _tmpPerp = v2();

    /** 重叠引力区切换宿主时的强度倍率阈值，避免两星之间来回抖动 */
    private readonly _dominanceSwitchRatio = 1.12;

    /** 当前主要处于哪颗星的引力井内（用于掠过辅助捕获） */
    private _gravDwellStar: Star | null = null;
    private _gravDwellSec = 0;

    get alpha(): number {
        return this._alpha;
    }

    registerStar(star: Star): void {
        if (!star.isAlive()) {
            return;
        }
        if (this._stars.indexOf(star) < 0) {
            this._stars.push(star);
        }
    }

    unregisterStar(star: Star): void {
        const idx = this._stars.indexOf(star);
        if (idx >= 0) {
            this._stars.splice(idx, 1);
        }
    }

    registerPlayer(player: Player): void {
        this._player = player;
    }

    /** 关卡重开时清空注册表与积分累加器 */
    reset(): void {
        this._stars.length = 0;
        this._player = null;
        this._accumulator = 0;
        this._alpha = 0;
        this._gravDwellStar = null;
        this._gravDwellSec = 0;
    }

    /** 剔除已 destroy 的星球，避免重试关卡时访问 null.node */
    private _purgeInvalidStars(): void {
        for (let i = this._stars.length - 1; i >= 0; i--) {
            if (!this._stars[i].isAlive()) {
                this._stars.splice(i, 1);
            }
        }
    }

    get stars(): readonly Star[] {
        return this._stars;
    }

    /** 在起始星上放置飞船并赋予圆轨道切向速度 */
    initPlayerOrbit(player: Player, host: Star, altitude?: number): void {
        const alt = altitude ?? host.orbitMinAltitude;
        const hostPos = host.getPhysicsPosition();
        const r = this._minOrbitRadius(host, player, alt);
        player.physicsPos.set(hostPos.x + r, hostPos.y);
        const vOrbit = this.computeCircularOrbitSpeed(host, r);
        // 初始切向：起始星与自转同向（init 仅用于出生星）
        const orbitSign =
            host.isStartStar ? (host.getPreferredOrbitSign() ?? 1) : 1;
        player.physicsVel.set(0, vOrbit * orbitSign);
        player.syncRenderState();
        player.beginOrbiting(host);
    }

    /** 可见公转带内缘：星半径 + 离地高度 + 飞船自身半径 */
    private _minOrbitRadius(star: Star, player: Player, altitude?: number): number {
        const alt = altitude ?? star.orbitMinAltitude;
        return star.radius + alt + player.getLogicRadius();
    }

    /** 圆轨道切向速度 |v| = sqrt(G·M/r) */
    computeCircularOrbitSpeed(star: Star, radius: number): number {
        const r = Math.max(radius, star.radius * 0.5);
        return Math.sqrt(star.gravityConstant * star.mass / r);
    }

    /** 逃逸速度 |v| = sqrt(2·G·M/r) */
    computeEscapeSpeed(star: Star, radius: number): number {
        const r = Math.max(radius, star.radius * 0.5);
        return Math.sqrt(2 * star.gravityConstant * star.mass / r);
    }

    /**
     * 公转中点击星球本体外：反转当前公转方向，并立即对齐切向速度。
     */
    reverseOrbitDirection(player: Player): boolean {
        const host = player.boundStar;
        if (player.flightMode !== FlightMode.Orbiting || !host?.isAlive()) {
            return false;
        }

        const hostPos = host.getPhysicsPosition();
        const rx = player.physicsPos.x - hostPos.x;
        const ry = player.physicsPos.y - hostPos.y;

        // 当前有效切向符号：玩家已选则沿用，否则由角动量推断
        const currentSign =
            player.orbitDirectionSign ??
            (rx * player.physicsVel.y - ry * player.physicsVel.x >= 0 ? 1 : -1);
        const sign = currentSign > 0 ? -1 : 1;

        player.orbitDirectionSign = sign;
        this._alignOrbitTangent(player, host, sign);
        return true;
    }

    /** 按指定切向符号重设公转切向速度（保留径向分量） */
    private _alignOrbitTangent(player: Player, host: Star, sign: number): void {
        const hostPos = host.getPhysicsPosition();
        const rx = player.physicsPos.x - hostPos.x;
        const ry = player.physicsPos.y - hostPos.y;
        Math2D.normalize(v2(rx, ry), this._tmpDir);
        Math2D.decomposeRadial(player.physicsVel, this._tmpDir, this._tmpRadial, this._tmpTangential);
        const r = Math.max(Math2D.len(v2(rx, ry)), this._minOrbitRadius(host, player));
        const vOrbit = this.computeCircularOrbitSpeed(host, r);
        Math2D.perpendicularCCW(this._tmpDir, this._tmpPerp);
        player.physicsVel.x = this._tmpRadial.x + this._tmpPerp.x * vOrbit * sign;
        player.physicsVel.y = this._tmpRadial.y + this._tmpPerp.y * vOrbit * sign;
    }

    /** 每渲染帧调用：固定步积分 + 更新插值 alpha */
    tick(frameDt: number): void {
        if (!this._player) {
            return;
        }

        this._purgeInvalidStars();
        const dt = Math2D.clampDt(frameDt);
        this._accumulator += dt;
        let steps = 0;
        while (this._accumulator >= FIXED_DT && steps < MAX_PHYSICS_STEPS) {
            this._integrateStep(FIXED_DT);
            this._accumulator -= FIXED_DT;
            steps++;
        }
        this._alpha = this._accumulator / FIXED_DT;
    }

    /** 点火：沿径向向外叠加冲量，保留切向速度 → 自然脱离公转。成功返回 true */
    ignitePlayer(impulse?: number): boolean {
        const player = this._player;
        if (!player) {
            return false;
        }

        const host = player.getIgniteHost();
        if (!host) {
            return false;
        }

        const impulseMag = impulse ?? player.ignitionImpulse;
        const hostPos = host.getPhysicsPosition();
        Math2D.normalize(
            v2(player.physicsPos.x - hostPos.x, player.physicsPos.y - hostPos.y),
            this._tmpDir,
        );
        player.physicsVel.x += this._tmpDir.x * impulseMag;
        player.physicsVel.y += this._tmpDir.y * impulseMag;
        player.beginFreeFlightAfterIgnite(host);
        return true;
    }

    private _integrateStep(dt: number): void {
        const player = this._player!;
        player.savePreviousState();
        player.tickOutOfBoundsGrace(dt);

        // 1. 叠加所有星球引力（惯性 / 公转 / 入轨全程真实积分，保证丝滑）
        this._applyGravity(player, dt);

        // 2. 根据飞行模式做软约束 / 软捕获
        switch (player.flightMode) {
            case FlightMode.Orbiting:
                this._updateOrbiting(player, dt);
                // 绕 A 路过 B 时，若 B 引力占优则软切换到 B 入轨
                this._tryOrbitHandoff(player);
                break;
            case FlightMode.Settling:
                this._updateSettling(player, dt);
                break;
            case FlightMode.FreeFlight:
                // 捕获判定移到位移之后，见 _tryCapture
                break;
        }

        // 3. 位置积分
        player.physicsPos.x += player.physicsVel.x * dt;
        player.physicsPos.y += player.physicsVel.y * dt;

        this._clampPlayerSpeed(player);

        // 4. 位移后检测捕获（防止高速一帧穿过星体/引力区漏判）
        if (player.flightMode === FlightMode.FreeFlight) {
            this._tryCapture(player, dt);
        }

        // 5. 公转/入轨后保证轨道在星球视觉外缘之上
        if (player.flightMode === FlightMode.Orbiting && player.boundStar) {
            this._liftToMinOrbit(player, player.boundStar, dt);
        } else if (player.flightMode === FlightMode.Settling && player.settlingStar) {
            this._liftToMinOrbit(player, player.settlingStar, dt);
        } else if (player.flightMode === FlightMode.FreeFlight) {
            // 已在稳定轨道但未切换状态时，自动升级为公转态
            this._tryPromoteStableOrbit(player);
        }
    }

    /**
     * 软抬升：当轨道半径小于可见下限时，沿径向向外推移位置并收束切向速度。
     * 捕获入轨时即使接触星面，也会滑到星体外的可见公转带，而非缩在星球内部。
     */
    private _liftToMinOrbit(player: Player, star: Star, dt: number): void {
        const minR = this._minOrbitRadius(star, player);
        const starPos = star.getPhysicsPosition();
        const rx = player.physicsPos.x - starPos.x;
        const ry = player.physicsPos.y - starPos.y;
        const dist = Math2D.len(v2(rx, ry));
        if (dist >= minR || dist < 1e-4) {
            return;
        }

        Math2D.normalize(v2(rx, ry), this._tmpDir);
        const deficit = minR - dist;
        // 深入星体内部时加速抬升到可见公转带
        const insideBody = dist < star.radius + player.getLogicRadius();
        const liftBoost = insideBody ? 4 : 1;
        const liftT = Math.min(1, star.orbitLiftStrength * dt * liftBoost);
        player.physicsPos.x += this._tmpDir.x * deficit * liftT;
        player.physicsPos.y += this._tmpDir.y * deficit * liftT;

        // 切向速度对齐到抬升后的圆轨道速度，保持丝滑公转
        const newDist = Math.max(minR, dist + deficit * liftT);
        const vOrbit = this.computeCircularOrbitSpeed(star, newDist);
        Math2D.decomposeRadial(player.physicsVel, this._tmpDir, this._tmpRadial, this._tmpTangential);
        const sign = this._orbitTangentSign(
            rx,
            ry,
            player.physicsVel,
            this._tmpTangential,
            this._tmpDir,
            player,
            star,
        );
        Math2D.perpendicularCCW(this._tmpDir, this._tmpPerp);
        const tangentialBlend = Math.min(1, star.atmosphereEntrainment * dt * (insideBody ? 1.2 : 0.5));
        const targetVx = this._tmpPerp.x * vOrbit * sign;
        const targetVy = this._tmpPerp.y * vOrbit * sign;
        player.physicsVel.x += (targetVx - player.physicsVel.x) * tangentialBlend;
        player.physicsVel.y += (targetVy - player.physicsVel.y) * tangentialBlend;
    }

    /**
     * 圆轨道切向符号。
     * - 玩家手动指定（orbitDirectionSign）优先
     * - 起始星：与自转同向
     * - 其它星：由切入时的切向 / 角动量决定
     */
    private _orbitTangentSign(
        rx: number,
        ry: number,
        vel: Vec2,
        tangential: Vec2,
        radialDir: Vec2,
        player: Player,
        host?: Star | null,
    ): number {
        if (player.orbitDirectionSign !== null) {
            return player.orbitDirectionSign > 0 ? 1 : -1;
        }

        if (host?.isStartStar) {
            const preferred = host.getPreferredOrbitSign();
            if (preferred !== null) {
                return preferred;
            }
        }

        Math2D.perpendicularCCW(radialDir, this._tmpPerp);
        const tanLen = Math2D.len(tangential);
        if (tanLen > 1e-2) {
            const tangDot =
                tangential.x * this._tmpPerp.x + tangential.y * this._tmpPerp.y;
            return tangDot >= 0 ? 1 : -1;
        }
        const angMom = rx * vel.y - ry * vel.x;
        return angMom >= 0 ? 1 : -1;
    }

    /** 公转/入轨时的宿主星（仅对其做两体引力，避免邻星拉扯导致星内振荡） */
    private _getOrbitHost(player: Player): Star | null {
        if (player.flightMode === FlightMode.Orbiting) {
            return player.boundStar;
        }
        if (player.flightMode === FlightMode.Settling) {
            return player.settlingStar;
        }
        return null;
    }

    /**
     * 公转中路过邻星：新星引力明显更强且已进入其引力井时，切到软入轨。
     * 解决「绕 A 时被 B 吸住但仍绑 A」的异常轨迹。
     */
    private _tryOrbitHandoff(player: Player): void {
        const current = player.boundStar;
        if (!current?.isAlive()) {
            return;
        }

        const dom = this._findDominantStar(player);
        if (!dom || dom.star === current) {
            return;
        }

        const currentAccel = this._computeGravityAccel(current, player.physicsPos, player);
        if (dom.accel < currentAccel * this._dominanceSwitchRatio) {
            return;
        }

        const shipR = player.getLogicRadius();
        const deepWell = dom.dist <= dom.star.gravityRange * 0.55;
        const nearSurface = dom.dist <= dom.star.radius + shipR + dom.star.landingContactEpsilon * 2;
        if (deepWell || nearSurface) {
            player.beginSettling(dom.star);
        }
    }

    /** 对单颗星球施加引力加速度（惯性飞行时加强，便于掠过弯折） */
    private _applyGravityFromStar(star: Star, player: Player, dt: number): void {
        if (!star.isAlive()) {
            return;
        }
        const accel = this._computeGravityAccel(star, player.physicsPos, player);
        if (accel <= 0) {
            return;
        }

        const starPos = star.getPhysicsPosition();
        const dx = starPos.x - player.physicsPos.x;
        const dy = starPos.y - player.physicsPos.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        player.physicsVel.x += (dx / dist) * accel * dt;
        player.physicsVel.y += (dy / dist) * accel * dt;
    }

    /** 防止多星叠加引力导致速度发散，保证轨迹可预测 */
    private _clampPlayerSpeed(player: Player, maxSpeed = 2400): void {
        const speed = Math2D.len(player.physicsVel);
        if (speed <= maxSpeed || speed < 1e-4) {
            return;
        }
        const scale = maxSpeed / speed;
        player.physicsVel.x *= scale;
        player.physicsVel.y *= scale;
    }

    /** 万有引力：公转/入轨仅受宿主星；惯性飞行受全部星球（N 体） */
    private _applyGravity(player: Player, dt: number): void {
        const host = this._getOrbitHost(player);
        if (host?.isAlive()) {
            this._applyGravityFromStar(host, player, dt);
            return;
        }

        for (const star of this._stars) {
            if (!star.isAlive()) {
                continue;
            }
            this._applyGravityFromStar(star, player, dt);
        }
    }

    /**
     * 计算某星球在飞船位置处的引力加速度标量 a = G·M/r²。
     * 超出 gravityRange 时返回 0；惯性飞行时加强并减弱 softening。
     */
    private _computeGravityAccel(star: Star, pos: Vec2, player?: Player | null): number {
        if (!star.isAlive()) {
            return 0;
        }
        const starPos = star.getPhysicsPosition();
        const dx = starPos.x - pos.x;
        const dy = starPos.y - pos.y;
        const distSq = dx * dx + dy * dy;
        const range = star.gravityRange;
        if (distSq > range * range) {
            return 0;
        }

        const freeFlight = player?.flightMode === FlightMode.FreeFlight;
        const softenScale = freeFlight ? FREE_FLIGHT_SOFTEN_SCALE : 1;
        const boost = freeFlight ? FREE_FLIGHT_GRAVITY_BOOST : 1;
        const soft = (GRAVITY_SOFTENING + star.radius * 0.15) * softenScale;
        const effectiveR2 = Math.max(distSq, soft * soft);
        let accel = (star.gravityConstant * star.mass) / effectiveR2;

        // 引力圈外缘平滑衰减，进入范围内牵引渐强
        const dist = Math.sqrt(distSq);
        if (dist > range * 0.88) {
            const fade = (range - dist) / (range * 0.12);
            accel *= Math.max(0, Math.min(1, fade));
        }

        return accel * boost;
    }

    /** 飞船到星球中心的距离 */
    private _distToStar(star: Star, pos: Vec2): number {
        const starPos = star.getPhysicsPosition();
        return Math2D.dist(pos, starPos);
    }

    /**
     * 在引力范围内的所有星球中，取当前位置引力加速度最大者。
     * 两星重叠时，由「此刻谁拉得更猛」决定捕获归属。
     */
    private _findDominantStar(player: Player): { star: Star; accel: number; dist: number } | null {
        let bestStar: Star | null = null;
        let bestAccel = 0;
        let bestDist = 0;

        for (const star of this._stars) {
            if (!star.isAlive()) {
                continue;
            }
            const accel = this._computeGravityAccel(star, player.physicsPos, player);
            if (accel <= bestAccel) {
                continue;
            }
            bestAccel = accel;
            bestStar = star;
            bestDist = this._distToStar(star, player.physicsPos);
        }

        if (!bestStar) {
            return null;
        }
        return { star: bestStar, accel: bestAccel, dist: bestDist };
    }

    /**
     * 软入轨过程中若进入双星重叠区，仅在新星引力明显更强时才切换宿主，
     * 避免平衡点附近抖动。
     */
    private _resolveSettlingStar(player: Player): Star | null {
        const dom = this._findDominantStar(player);
        if (!dom) {
            return null;
        }

        const current = player.settlingStar;
        if (!current || current === dom.star) {
            return dom.star;
        }

        const currentAccel = this._computeGravityAccel(current, player.physicsPos, player);
        if (dom.accel >= currentAccel * this._dominanceSwitchRatio) {
            return dom.star;
        }
        return current;
    }

    /** 公转态：允许与宿主星本体视觉交错；轻微切向维持，防止轨道莫名发散 */
    private _updateOrbiting(player: Player, dt: number): void {
        const host = player.boundStar;
        if (!host) {
            player.beginFreeFlight();
            return;
        }

        const hostPos = host.getPhysicsPosition();
        const rx = player.physicsPos.x - hostPos.x;
        const ry = player.physicsPos.y - hostPos.y;
        Math2D.normalize(v2(rx, ry), this._tmpDir);
        Math2D.decomposeRadial(player.physicsVel, this._tmpDir, this._tmpRadial, this._tmpTangential);

        const r = Math.max(Math2D.len(v2(rx, ry)), this._minOrbitRadius(host, player));
        const vOrbit = this.computeCircularOrbitSpeed(host, r);
        Math2D.perpendicularCCW(this._tmpDir, this._tmpPerp);
        const autoSign = this._orbitTangentSign(
            rx,
            ry,
            player.physicsVel,
            this._tmpTangential,
            this._tmpDir,
            player,
            host,
        );
        const sign = player.orbitDirectionSign ?? autoSign;

        if (host.isStartStar || player.orbitDirectionSign !== null) {
            // 起始星或玩家已选方向：按符号收敛切向
            this._tmpTangential.set(this._tmpPerp.x * vOrbit * sign, this._tmpPerp.y * vOrbit * sign);
        } else {
            // 捕获星：保留切入切向，仅归一化到圆轨道速度，不翻转方向
            const tanLen = Math2D.len(this._tmpTangential);
            if (tanLen > 1e-4) {
                const scale = vOrbit / tanLen;
                this._tmpTangential.x *= scale;
                this._tmpTangential.y *= scale;
            } else {
                this._tmpTangential.set(this._tmpPerp.x * vOrbit * sign, this._tmpPerp.y * vOrbit * sign);
            }
        }

        // 公转态仅对切向做极弱收敛，径向完全交给真实引力（可产生轻微椭圆，更自然）
        const align = host.orbitMaintainStrength * dt;
        player.physicsVel.x += (this._tmpTangential.x - player.physicsVel.x) * align * 0.35;
        player.physicsVel.y += (this._tmpTangential.y - player.physicsVel.y) * align * 0.35;
    }

    /** 是否接触星体本体（星半径 + 飞船半径 + 容差） */
    private _isSurfaceContact(star: Star, dist: number, shipRadius: number): boolean {
        return dist <= star.radius + shipRadius + star.landingContactEpsilon;
    }

    /** 本物理步线段是否扫过星体（防止高速一帧穿透） */
    private _sweepSurfaceContact(star: Star, p0: Vec2, p1: Vec2, shipRadius: number): boolean {
        const starPos = star.getPhysicsPosition();
        const contact = star.radius + shipRadius + star.landingContactEpsilon;
        const ax = p1.x - p0.x;
        const ay = p1.y - p0.y;
        const lenSq = ax * ax + ay * ay;
        if (lenSq < 1e-6) {
            return this._distToStar(star, p1) <= contact;
        }
        const t = Math.max(
            0,
            Math.min(1, ((starPos.x - p0.x) * ax + (starPos.y - p0.y) * ay) / lenSq),
        );
        const cx = p0.x + ax * t;
        const cy = p0.y + ay * t;
        const dx = cx - starPos.x;
        const dy = cy - starPos.y;
        return dx * dx + dy * dy <= contact * contact;
    }

    /** 线段 p0→p1 到 center 的最近距离（用于掠过轨迹判定） */
    private _closestApproachOnSegment(p0: Vec2, p1: Vec2, center: Vec2): number {
        const ax = p1.x - p0.x;
        const ay = p1.y - p0.y;
        const lenSq = ax * ax + ay * ay;
        if (lenSq < 1e-6) {
            return Math2D.dist(p0, center);
        }
        const t = Math.max(
            0,
            Math.min(1, ((center.x - p0.x) * ax + (center.y - p0.y) * ay) / lenSq),
        );
        const cx = p0.x + ax * t;
        const cy = p0.y + ay * t;
        return Math.hypot(cx - center.x, cy - center.y);
    }

    /** 比束缚能 E = v²/2 − GM/r；E < 0 表示相对该星已被引力束缚 */
    private _specificEnergy(star: Star, pos: Vec2, vel: Vec2): number {
        const dist = this._distToStar(star, pos);
        const r = Math.max(dist, star.radius * 0.5);
        const speedSq = vel.x * vel.x + vel.y * vel.y;
        const mu = star.gravityConstant * star.mass;
        return speedSq * 0.5 - mu / r;
    }

    /** 相对星心的径向外向速度（>0 表示正在远离） */
    private _radialSpeedOut(star: Star, pos: Vec2, vel: Vec2): number {
        const starPos = star.getPhysicsPosition();
        const rx = pos.x - starPos.x;
        const ry = pos.y - starPos.y;
        Math2D.normalize(v2(rx, ry), this._tmpDir);
        return vel.x * this._tmpDir.x + vel.y * this._tmpDir.y;
    }

    /** 更新在主导引力井内的停留时间，供掠过辅助捕获使用 */
    private _updateGravWellDwell(player: Player, dt: number): void {
        const dom = this._findDominantStar(player);
        if (!dom) {
            this._gravDwellStar = null;
            this._gravDwellSec = 0;
            return;
        }
        if (this._gravDwellStar === dom.star) {
            this._gravDwellSec += dt;
        } else {
            this._gravDwellStar = dom.star;
            this._gravDwellSec = dt;
        }
    }

    private _isCaptureBlocked(player: Player, star: Star): boolean {
        return player.captureCooldown > 0 && player.lastIgniteHost === star;
    }

    private _commitCapture(player: Player, star: Star): void {
        player.captureCooldown = 0;
        player.lastIgniteHost = null;
        this._gravDwellStar = null;
        this._gravDwellSec = 0;
        player.beginSettling(star);
    }

    /**
     * 单星捕获评估：贴星 / 掠过引力井 / 束缚能 / 井内停留 / 切向弯折等。
     * 不要求直线命中星体，进入 gravityRange 且轨迹被弯折即可软捕获。
     */
    private _shouldCaptureStar(player: Player, star: Star): boolean {
        if (!star.isAlive() || this._isCaptureBlocked(player, star)) {
            return false;
        }

        const shipR = player.getLogicRadius();
        const dist = this._distToStar(star, player.physicsPos);
        const range = star.gravityRange;
        const starPos = star.getPhysicsPosition();

        // 贴星或本帧轨迹扫过星体 → 立即捕获
        if (
            this._isSurfaceContact(star, dist, shipR) ||
            this._sweepSurfaceContact(star, player.prevPhysicsPos, player.physicsPos, shipR)
        ) {
            return true;
        }

        if (dist > range) {
            return false;
        }

        const speed = Math2D.len(player.physicsVel);
        const vEsc = this.computeEscapeSpeed(star, dist);
        const vRadOut = this._radialSpeedOut(star, player.physicsPos, player.physicsVel);
        const closest = this._closestApproachOnSegment(
            player.prevPhysicsPos,
            player.physicsPos,
            starPos,
        );
        const grazeInner = closest <= range * GRAZE_CAPTURE_RANGE_RATIO;
        const deepWell = dist <= range * 0.88;

        // 深入引力井：已被明显弯折，或速度/径向不再呈强逃逸
        if (deepWell) {
            if (
                speed < vEsc * 1.55 ||
                vRadOut <= star.leaveRadialSpeed * 0.3 ||
                this._gravDwellSec >= 0.04
            ) {
                return true;
            }
        }

        // 本帧掠过轨迹最近点进入内层引力区
        if (grazeInner && speed < vEsc * 1.45) {
            return true;
        }

        // 比束缚能为负 → 相对该星已被引力捕获
        if (this._specificEnergy(star, player.physicsPos, player.physicsVel) < 0) {
            return true;
        }

        // 在引力井内停留足够久且非强逃逸
        if (this._gravDwellStar === star && this._gravDwellSec >= GRAV_WELL_CAPTURE_DWELL) {
            if (speed < vEsc * 1.35 || vRadOut <= star.leaveRadialSpeed * 0.55) {
                return true;
            }
        }

        // 经典软捕获：低于逃逸速度且径向不外冲
        if (speed < vEsc * 0.98 && vRadOut <= star.leaveRadialSpeed * 0.45) {
            return true;
        }

        // 切向占优的弯折轨迹（掠过时被拉弯成轨道）
        const rx = player.physicsPos.x - starPos.x;
        const ry = player.physicsPos.y - starPos.y;
        Math2D.normalize(v2(rx, ry), this._tmpDir);
        Math2D.decomposeRadial(player.physicsVel, this._tmpDir, this._tmpRadial, this._tmpTangential);
        const vTan = Math2D.len(this._tmpTangential);
        if (
            dist <= range * 0.92 &&
            vTan > speed * 0.48 &&
            vRadOut <= star.leaveRadialSpeed * 0.4
        ) {
            return true;
        }

        return false;
    }

    /**
     * 位移后评估是否被捕获。
     * - 遍历引力范围内所有星球，按引力强度优先
     * - 掠过外层引力井即可软捕获，无需直接命中星体
     * - 点火冷却：仅阻止被「刚离开的同一颗星」再次吸回
     */
    private _tryCapture(player: Player, dt: number): void {
        if (player.captureCooldown > 0) {
            player.captureCooldown = Math.max(0, player.captureCooldown - dt);
        }

        this._updateGravWellDwell(player, dt);

        // 按当前位置引力强度排序，优先评估主导星
        const candidates: { star: Star; accel: number }[] = [];
        for (const star of this._stars) {
            if (!star.isAlive()) {
                continue;
            }
            const accel = this._computeGravityAccel(star, player.physicsPos, player);
            if (accel <= 0) {
                continue;
            }
            candidates.push({ star, accel });
        }
        candidates.sort((a, b) => b.accel - a.accel);

        for (const { star } of candidates) {
            if (this._shouldCaptureStar(player, star)) {
                this._commitCapture(player, star);
                return;
            }
        }
    }

    /**
     * 软入轨：径向阻尼 + 切向 entraining 到圆轨道速度。
     * 允许视觉穿插星体，数帧内自然滑入公转。
     */
    private _updateSettling(player: Player, dt: number): void {
        const star = this._resolveSettlingStar(player);
        if (!star) {
            player.beginFreeFlight();
            return;
        }

        // 重叠区切换宿主：切换新星时重置入轨计时
        if (player.settlingStar !== star) {
            player.settlingStar = star;
            player.settleElapsed = 0;
        }

        player.settleElapsed += dt;
        const starPos = star.getPhysicsPosition();
        const rx = player.physicsPos.x - starPos.x;
        const ry = player.physicsPos.y - starPos.y;
        const actualDist = Math2D.len(v2(rx, ry));
        const minR = this._minOrbitRadius(star, player);
        Math2D.normalize(v2(rx, ry), this._tmpDir);
        Math2D.decomposeRadial(player.physicsVel, this._tmpDir, this._tmpRadial, this._tmpTangential);

        const vRadSigned =
            this._tmpRadial.x * this._tmpDir.x + this._tmpRadial.y * this._tmpDir.y;

        // 径向阻尼：星内时加强向内速度衰减
        let radialKeep = Math.max(0, 1 - star.atmosphereDrag * dt);
        if (actualDist < minR && vRadSigned < 0) {
            radialKeep *= Math.max(0, 1 - star.atmosphereDrag * dt * 2);
        }
        let dampedRadX = this._tmpRadial.x * radialKeep;
        let dampedRadY = this._tmpRadial.y * radialKeep;

        // 轨道半径不足：沿径向向外软拉，避免在星内来回弹
        if (actualDist < minR && actualDist > 1e-4) {
            const deficit = minR - actualDist;
            const pullT = Math.min(1, star.landingSoftPull * dt);
            const outwardBoost = deficit * pullT * 10;
            dampedRadX += this._tmpDir.x * outwardBoost;
            dampedRadY += this._tmpDir.y * outwardBoost;
        }

        // 切向 entraining：用真实半径计算圆轨道速度，符号保持稳定
        const orbitR = Math.max(actualDist, minR * 0.92);
        const vOrbit = this.computeCircularOrbitSpeed(star, orbitR);
        Math2D.perpendicularCCW(this._tmpDir, this._tmpPerp);
        const sign = this._orbitTangentSign(
            rx,
            ry,
            player.physicsVel,
            this._tmpTangential,
            this._tmpDir,
            player,
            star,
        );
        const targetTx = this._tmpPerp.x * vOrbit * sign;
        const targetTy = this._tmpPerp.y * vOrbit * sign;

        let entrain = Math.min(1, star.atmosphereEntrainment * dt);
        if (actualDist <= star.radius + star.landingContactEpsilon * 2) {
            entrain = Math.min(1, entrain + star.surfaceEntrainmentBoost * dt);
        }
        if (actualDist < minR) {
            entrain = Math.min(1, entrain * 1.6);
        }

        const tanX = this._tmpTangential.x + (targetTx - this._tmpTangential.x) * entrain;
        const tanY = this._tmpTangential.y + (targetTy - this._tmpTangential.y) * entrain;

        player.physicsVel.x = dampedRadX + tanX;
        player.physicsVel.y = dampedRadY + tanY;

        const settled =
            player.settleElapsed >= star.groundSettleDuration &&
            actualDist >= minR * 0.92 &&
            Math.abs(vRadSigned) < star.landingTolerance * 2.5;

        if (settled) {
            this._liftToMinOrbit(player, star, 1 / 30);
            player.beginOrbiting(star);
            player.lastIgniteHost = null;
            player.captureCooldown = 0;
        }
    }

    /**
     * 自由飞行中若已形成稳定轨道（低径向速度、以切向为主），自动切公转态。
     * 解决「看起来在公转但状态仍是 FreeFlight 点不着火」的问题。
     */
    private _tryPromoteStableOrbit(player: Player): void {
        const dom = this._findDominantStar(player);
        if (!dom) {
            return;
        }

        const { star, dist } = dom;
        const speed = Math2D.len(player.physicsVel);
        if (speed < 1e-2) {
            return;
        }

        const vEsc = this.computeEscapeSpeed(star, dist);
        if (speed >= vEsc * 0.88) {
            return;
        }

        const starPos = star.getPhysicsPosition();
        const rx = player.physicsPos.x - starPos.x;
        const ry = player.physicsPos.y - starPos.y;
        Math2D.normalize(v2(rx, ry), this._tmpDir);
        Math2D.decomposeRadial(player.physicsVel, this._tmpDir, this._tmpRadial, this._tmpTangential);
        const vRad = Math.abs(
            this._tmpRadial.x * this._tmpDir.x + this._tmpRadial.y * this._tmpDir.y,
        );
        const vTan = Math2D.len(this._tmpTangential);

        if (vRad > star.landingTolerance * 3) {
            return;
        }
        if (vTan < speed * 0.45) {
            return;
        }

        player.beginOrbiting(star);
    }
}
