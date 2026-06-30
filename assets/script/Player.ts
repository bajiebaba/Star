import { _decorator, Component, Node, UITransform, Vec2, v2 } from 'cc';
import { Math2D } from './core/Math2D';
import type { Star } from './Star';

const { ccclass, property } = _decorator;

/** 飞船飞行模式 */
export enum FlightMode {
    /** 被某颗星球捕获，可点火逃逸 */
    Orbiting = 0,
    /** 点火后惯性飞行，不可操作 */
    FreeFlight = 1,
    /** 引力/星面软捕获过渡中 */
    Settling = 2,
}

/**
 * 勘探飞船：物理态由 PhysicsManager 驱动，本组件负责插值渲染与朝向。
 */
@ccclass('Player')
export class Player extends Component {
    @property({ tooltip: '飞船质量（极小，仅用于后续扩展）' })
    mass = 10;

    @property({ tooltip: '逻辑碰撞半径；0 表示自动估算' })
    bodyRadius = 0;

    @property({ tooltip: '点火基准冲量（px/s），满蓄时达到 chargeMaxRatio 倍' })
    ignitionImpulse = 420;

    @property({ tooltip: '蓄力至满所需时间（秒）' })
    chargeMaxDuration = 1.0;

    @property({ tooltip: '瞬间松手时的最小冲量比例（相对 ignitionImpulse × chargeMaxRatio）' })
    chargeMinRatio = 0.35;

    @property({ tooltip: '满蓄冲量比例（相对 ignitionImpulse）' })
    chargeMaxRatio = 1.0;

    @property({
        tooltip: '船头素材相对数学 +X 轴的偏移（度）。竖长箭头素材通常填 -90',
    })
    bodyHeadingOffset = -90;

    @property({ tooltip: '惯性飞行时船头追随速度的平滑时间（秒）' })
    headingSmoothTimeFree = 0.16;

    @property({ tooltip: '公转/入轨捕获时船头转向平滑时间（秒），略长以体现被弯折感' })
    headingSmoothTimeOrbit = 0.44;

    @property({ tooltip: '船头最大转向角速度（度/秒），防止大角度瞬转' })
    maxHeadingTurnDegPerSec = 420;

    /** 入轨过渡期：从速度方向 blend 到径向法线所需时间（秒） */
    @property({ tooltip: '软捕获入轨时，由速度朝向过渡到轨道法线的时间（秒）' })
    headingCaptureBlendDuration = 0.9;

    @property({ tooltip: '软入轨后期允许点火的最早时刻（秒，自进入 Settling 起计）' })
    settlingIgniteDelay = 0.4;

    @property({ tooltip: '公转时首个子节点沿轨道法线（径向）正弦浮动幅度（px，纯视觉）' })
    orbitPulseFloatAmp = 6;

    @property({ tooltip: '公转正弦波频率（Hz）' })
    orbitPulseFreq = 1.15;

    @property({ tooltip: '点击星球外反转公转方向时的平滑掉头时长（秒）' })
    orbitReverseDuration = 0.4;

    @property({ tooltip: '两次反转公转方向的最小间隔（秒），防误触连点' })
    orbitReverseMinInterval = 0.3;

    @property({ tooltip: '公转转向（掉头）时船头相对法线朝前进切向倾斜的角度（度）' })
    orbitTurnTiltDeg = 18;

    /** 玩家指定公转切向符号（+1 CCW / −1 CW）；null 表示由捕获/起始星自动决定 */
    orbitDirectionSign: number | null = null;
    /** 平滑掉头过渡剩余时间（秒），>0 表示切向速度正朝反向收敛 */
    orbitReverseRemaining = 0;

    /** 当前物理位置 / 速度（game 节点本地坐标） */
    readonly physicsPos = v2();
    readonly physicsVel = v2();
    /** 上一物理步状态，用于渲染插值 */
    readonly prevPhysicsPos = v2();
    readonly prevPhysicsVel = v2();

    flightMode: FlightMode = FlightMode.Orbiting;
    boundStar: Star | null = null;
    settlingStar: Star | null = null;
    settleElapsed = 0;
    /** 点火后短暂免疫捕获，避免刚脱离又被同一引力区吸回 */
    captureCooldown = 0;
    /** 最近一次点火离开的宿主星，冷却只对它生效 */
    lastIgniteHost: Star | null = null;
    /** 点火后出界免疫倒计时（秒），避免刚脱离就被误判失败 */
    outOfBoundsGrace = 0;

    private _bodyNode: Node | null = null;

    /** 当前渲染用的船头朝向（度，未加 bodyHeadingOffset） */
    private _displayHeadingDeg: number | null = null;
    /** smoothDampAngle 用的角速度状态 */
    private readonly _headingAngularVel = { value: 0 };
    /** 公转视觉正弦波相位（弧度） */
    private _orbitPulsePhase = 0;
    /** 公转上下浮动目标：player 的第一个子节点 */
    private _floatNode: Node | null = null;
    private _floatBaseX = 0;
    private _floatBaseY = 0;
    private _floatBaseZ = 0;

    onLoad(): void {
        this._bodyNode = this._resolveBodyNode();

        // 避免 UITransform 为 0 导致不渲染；body 锚点改为中心，与物理位置对齐
        const rootUi = this.getComponent(UITransform);
        if (rootUi) {
            rootUi.setContentSize(64, 64);
            rootUi.setAnchorPoint(0.5, 0.5);
        }
        const bodyUi = this._bodyNode?.getComponent(UITransform);
        if (bodyUi) {
            bodyUi.setAnchorPoint(0.5, 0.5);
        }
        this._resolveFloatNode();
    }

    /** 首个子节点：公转时沿轨道法线方向正弦浮动 */
    private _resolveFloatNode(): void {
        this._floatNode = this.node.children.length > 0 ? this.node.children[0] : null;
        if (this._floatNode) {
            const p = this._floatNode.position;
            this._floatBaseX = p.x;
            this._floatBaseY = p.y;
            this._floatBaseZ = p.z;
        }
    }

    /** 查找飞船视觉节点：优先 body，否则用第一个子节点（兼容占位素材命名） */
    private _resolveBodyNode(): Node | null {
        const named = this.node.getChildByName('body');
        if (named) {
            return named;
        }
        return this.node.children.length > 0 ? this.node.children[0] : null;
    }

    /** 是否可点火：公转态，或软入轨已稳定一段时间 */
    canIgnite(): boolean {
        return this.getIgniteHost() !== null;
    }

    /** 点火时使用的宿主星球 */
    getIgniteHost(): Star | null {
        if (this.flightMode === FlightMode.Orbiting && this.boundStar) {
            return this.boundStar;
        }
        // 软入轨后期视为已捕获，避免长期卡在 Settling 无法点火
        if (
            this.flightMode === FlightMode.Settling &&
            this.settlingStar &&
            this.settleElapsed >= this.settlingIgniteDelay
        ) {
            return this.settlingStar;
        }
        return null;
    }

    /**
     * 进入公转态。
     * @param preserveDirection 软入轨完成时升级公转时传 true，保留玩家在入轨期间选定的公转方向
     */
    beginOrbiting(star: Star, preserveDirection = false): void {
        this.flightMode = FlightMode.Orbiting;
        this.boundStar = star;
        this.settlingStar = null;
        this.settleElapsed = 0;
        this.outOfBoundsGrace = 0;
        this._orbitPulsePhase = 0;
        if (!preserveDirection) {
            this.orbitDirectionSign = null;
            this.orbitReverseRemaining = 0;
        }
    }

    beginFreeFlight(): void {
        this.flightMode = FlightMode.FreeFlight;
        this.boundStar = null;
        this.settlingStar = null;
        this.settleElapsed = 0;
        this.orbitDirectionSign = null;
        this.orbitReverseRemaining = 0;
        this._resetOrbitFloatVisual();
    }

    /** 点火后调用：仅对刚离开的宿主星免疫短暂再捕获 */
    beginFreeFlightAfterIgnite(host: Star, cooldownSec = 0.18, oobGraceSec = 1.2): void {
        this.beginFreeFlight();
        this.lastIgniteHost = host;
        this.captureCooldown = cooldownSec;
        this.outOfBoundsGrace = oobGraceSec;
    }

    /** 每物理步递减出界宽限 */
    tickOutOfBoundsGrace(dt: number): void {
        if (this.outOfBoundsGrace > 0) {
            this.outOfBoundsGrace = Math.max(0, this.outOfBoundsGrace - dt);
        }
    }

    beginSettling(star: Star): void {
        if (this.flightMode === FlightMode.Settling && this.settlingStar === star) {
            return;
        }
        this.flightMode = FlightMode.Settling;
        this.settlingStar = star;
        this.boundStar = null;
        this.settleElapsed = 0;
        this.orbitDirectionSign = null;
        this.orbitReverseRemaining = 0;
        this._resetOrbitFloatVisual();
    }

    savePreviousState(): void {
        this.prevPhysicsPos.set(this.physicsPos);
        this.prevPhysicsVel.set(this.physicsVel);
    }

    /** 首帧或重置时同步 prev = curr，避免插值跳变 */
    syncRenderState(): void {
        this.prevPhysicsPos.set(this.physicsPos);
        this.prevPhysicsVel.set(this.physicsVel);
        // 重置朝向平滑，下一帧从当前目标重新对齐
        this._displayHeadingDeg = null;
        this._headingAngularVel.value = 0;
        this._orbitPulsePhase = 0;
        this._resetOrbitFloatVisual();
    }

    /** 公转态：首个子节点沿宿主星径向（轨道法线）正弦浮动 */
    private _applyOrbitFloatVisual(dt: number, shipPos: Vec2): void {
        if (!this._floatNode?.isValid) {
            this._resolveFloatNode();
        }
        const floatNode = this._floatNode;
        const host = this.boundStar;
        if (!floatNode) {
            return;
        }

        if (this.flightMode !== FlightMode.Orbiting || !host?.isAlive()) {
            this._resetOrbitFloatVisual();
            return;
        }

        this._orbitPulsePhase += dt * this.orbitPulseFreq * Math.PI * 2;
        const wave = Math.sin(this._orbitPulsePhase) * this.orbitPulseFloatAmp;

        // 法线 = 星心 → 飞船，与公转时船头朝向一致
        const starPos = host.getPhysicsPosition();
        const rx = shipPos.x - starPos.x;
        const ry = shipPos.y - starPos.y;
        const dist = Math.hypot(rx, ry);
        if (dist > 1e-4) {
            const nx = rx / dist;
            const ny = ry / dist;
            floatNode.setPosition(
                this._floatBaseX + nx * wave,
                this._floatBaseY + ny * wave,
                this._floatBaseZ,
            );
        } else {
            floatNode.setPosition(this._floatBaseX, this._floatBaseY, this._floatBaseZ);
        }
    }

    private _resetOrbitFloatVisual(): void {
        if (!this._floatNode?.isValid) {
            return;
        }
        this._floatNode.setPosition(this._floatBaseX, this._floatBaseY, this._floatBaseZ);
    }

    /**
     * 根据插值 alpha 更新节点位置与朝向。
     * - 公转 / 软入轨：船头沿轨道法线（背离宿主星心），捕获时由速度方向渐进过渡
     * - 惯性飞行：船头沿速度方向平滑追随（多星引力弯折时自然转体）
     */
    applyRender(alpha: number, outPos: Vec2, dt: number): void {
        outPos.set(
            this.prevPhysicsPos.x + (this.physicsPos.x - this.prevPhysicsPos.x) * alpha,
            this.prevPhysicsPos.y + (this.physicsPos.y - this.prevPhysicsPos.y) * alpha,
        );
        this.node.setPosition(outPos.x, outPos.y, 0);
        this._applyOrbitFloatVisual(dt, outPos);

        const vx =
            this.prevPhysicsVel.x + (this.physicsVel.x - this.prevPhysicsVel.x) * alpha;
        const vy =
            this.prevPhysicsVel.y + (this.physicsVel.y - this.prevPhysicsVel.y) * alpha;
        this._applyBodyRotation(outPos, vx, vy, dt);
    }

    /** 由插值速度计算目标朝向（度） */
    private _computeTargetHeadingDeg(outPos: Vec2, vx: number, vy: number): number | null {
        const orbitHost =
            this.flightMode === FlightMode.Orbiting
                ? this.boundStar
                : this.flightMode === FlightMode.Settling
                  ? this.settlingStar
                  : null;

        const speedSq = vx * vx + vy * vy;
        let velDeg: number | null =
            speedSq > 25 ? (Math.atan2(vy, vx) * 180) / Math.PI : null;

        if (orbitHost?.isAlive()) {
            const starPos = orbitHost.getPhysicsPosition();
            const rx = outPos.x - starPos.x;
            const ry = outPos.y - starPos.y;
            if (rx * rx + ry * ry > 1e-4) {
                const radialDeg = (Math.atan2(ry, rx) * 180) / Math.PI;

                // 软入轨：先沿飞行速度，再渐进对齐轨道法线（捕获弯折过程）
                if (this.flightMode === FlightMode.Settling && velDeg !== null) {
                    const blendT = Math.min(
                        1,
                        this.settleElapsed / Math.max(0.16, this.headingCaptureBlendDuration),
                    );
                    return Math2D.lerpAngleDeg(velDeg, radialDeg, blendT);
                }

                // 公转转向（掉头过渡）：船头由法线朝前进切向略微倾斜，表现喷射方向调整
                if (
                    this.flightMode === FlightMode.Orbiting &&
                    this.orbitReverseRemaining > 0 &&
                    this.orbitDirectionSign !== null
                ) {
                    return radialDeg + this.orbitTurnTiltDeg * this.orbitDirectionSign;
                }

                // 公转无操作：船头与法线同向（尾部喷射对抗引力，悬浮公转）
                return radialDeg;
            }
        }

        return velDeg;
    }

    /**
     * 更新 body 朝向：目标角经 smoothDampAngle 渐进到位，避免捕获/多星拉扯时瞬间跳变。
     */
    private _applyBodyRotation(outPos: Vec2, vx: number, vy: number, dt: number): void {
        if (!this._bodyNode?.isValid) {
            this._bodyNode = this._resolveBodyNode();
        }
        if (!this._bodyNode) {
            return;
        }

        const targetDeg = this._computeTargetHeadingDeg(outPos, vx, vy);
        if (targetDeg === null) {
            return;
        }

        const clampedDt = Math2D.clampDt(dt);
        const orbitLike =
            this.flightMode === FlightMode.Orbiting ||
            this.flightMode === FlightMode.Settling;
        const smoothTime = orbitLike
            ? this.headingSmoothTimeOrbit
            : this.headingSmoothTimeFree;

        if (this._displayHeadingDeg === null) {
            this._displayHeadingDeg = targetDeg;
            this._headingAngularVel.value = 0;
        } else {
            this._displayHeadingDeg = Math2D.smoothDampAngle(
                this._displayHeadingDeg,
                targetDeg,
                this._headingAngularVel,
                smoothTime,
                clampedDt,
                this.maxHeadingTurnDegPerSec,
            );
        }

        this._bodyNode.setRotationFromEuler(
            0,
            0,
            this._displayHeadingDeg + this.bodyHeadingOffset,
        );
    }

    /** 根据蓄力进度 [0,1] 计算实际点火冲量 */
    computeIgnitionImpulse(chargeRatio: number): number {
        const t = Math.min(1, Math.max(0, chargeRatio));
        const ratio = this.chargeMinRatio + (this.chargeMaxRatio - this.chargeMinRatio) * t;
        return this.ignitionImpulse * ratio;
    }

    getLogicRadius(): number {
        if (this.bodyRadius > 0) {
            return this.bodyRadius;
        }
        const body = this._bodyNode;
        if (body) {
            const ui = body.getComponent(UITransform);
            if (ui) {
                return Math.max(ui.contentSize.width, ui.contentSize.height) * 0.35;
            }
        }
        return 18;
    }
}
