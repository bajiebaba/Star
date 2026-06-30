import { _decorator, Color, Component, Graphics, Node, UITransform, Vec2, v2 } from 'cc';

const { ccclass, property } = _decorator;

/** 引力范围可视化子节点名（挂在 star 根节点下，与 body 同级，不参与自转） */
const GRAVITY_FIELD_NODE = 'gravity-field';
/** 自转 / 按压 pivot（中间节点，scale 保持 1） */
const BODY_PIVOT_NODE = 'body';
/** 精灵缩放节点（实际贴图，按 radius 调 scale） */
const BODY_VISUAL_NODE = 'spr';

/**
 * 星球：引力源 + 软捕获参数 + 自转视觉。
 * 物理质量 M 与 gravityConstant 共同决定 a = G·M/r²。
 */
@ccclass('Star')
export class Star extends Component {
    @property({ tooltip: '星球视觉/逻辑半径（px）' })
    radius = 160;

    @property({ tooltip: '星球质量，引力强度与之成正比' })
    mass = 10000;

    @property({ tooltip: '自转速度（度/秒），纯视觉' })
    rotationSpeed = 30;

    @property({ tooltip: '引力影响半径（px）' })
    gravityRange = 320;

    @property({ tooltip: '引力常数 G，与 mass 相乘得加速度量级' })
    gravityConstant = 100;

    @property({ tooltip: '是否显示引力覆盖范围（gravity-field 子节点）' })
    showGravityField = true;

    @property({ tooltip: '引力范围填充色（半透明）' })
    gravityFieldFill = new Color(90, 150, 255, 32);

    @property({ tooltip: '引力范围描边色' })
    gravityFieldStroke = new Color(110, 185, 255, 110);

    @property({ tooltip: '引力范围描边宽度（px）' })
    gravityFieldLineWidth = 2;

    @property({ tooltip: '公转态切向维持强度（原 angleAlignStrength）' })
    angleAlignStrength = 4;

    /** 公转维持别名，供 PhysicsManager 读取 */
    get orbitMaintainStrength(): number {
        return this.angleAlignStrength;
    }

    @property({ tooltip: '软入轨完成判定：径向速度低于此值视为稳定' })
    landingTolerance = 5;

    @property({ tooltip: '星面接触判定额外容差（px）' })
    landingContactEpsilon = 1.5;

    @property({ tooltip: '软入轨最短持续时间（秒）' })
    groundSettleDuration = 0.7;

    @property({ tooltip: '径向速度高于此值视为正在飞离，不触发远距捕获' })
    leaveRadialSpeed = 50;

    @property({ tooltip: '软入轨切向牵引强度（与 dt 相乘，越小入轨越慢）' })
    atmosphereEntrainment = 2;

    @property({ tooltip: '软入轨径向阻尼强度（与 dt 相乘，越小径向收敛越慢）' })
    atmosphereDrag = 2;

    @property({ tooltip: '星面附近切向 entraining 加成' })
    surfaceEntrainmentBoost = 4;

    @property({ tooltip: '软入轨径向软拉强度（与 dt 相乘，越小抬升越慢）' })
    landingSoftPull = 6;

    @property({ tooltip: '公转最小离地高度（px），保证飞船不被星球完全遮挡' })
    orbitMinAltitude = 40;

    @property({ tooltip: '公转半径过小时的向外抬升强度（越大越快回到可见轨道）' })
    orbitLiftStrength = 3;

    /** 是否为 M0 起始星 */
    @property
    isStartStar = false;

    @property({ tooltip: '天体公转角速度（度/秒），绕初始位置画圆，0=静止。配合 orbitalRadius 提供线速度，用于引力弹弓' })
    orbitalAngularSpeed = 0;

    @property({ tooltip: '天体公转半径（px），绕初始位置画圆的幅度；线速度 = 半径 × 角速度' })
    orbitalRadius = 0;

    @property({ tooltip: '天体公转初始相位（度）' })
    orbitalPhaseDeg = 0;

    @property({ tooltip: '点火点击判定：相对视觉半径的放宽倍率（1.0 = 正好贴合星球视觉边缘）' })
    bodyHitScale = 1.1;

    @property({ tooltip: '点火点击判定：视觉半径外额外 padding（px），小星球更易点中' })
    bodyHitPadding = 8;

    @property({ tooltip: '按下星球时 body 缩放倍率（相对基准 scale）' })
    pressBodyScale = 0.94;

    @property({ tooltip: '满蓄时 body 缩放倍率（相对基准 scale，应 ≤ pressBodyScale）' })
    chargeBodyScale = 0.88;

    private _bodyPivot: Node | null = null;
    /** spr 精灵节点；无 spr 时回退为 body pivot */
    private _bodyVisual: Node | null = null;
    /** body pivot 基准缩放（按压/蓄力视觉用，通常为 1） */
    private _bodyPivotBaseScaleX = 1;
    private _bodyPivotBaseScaleY = 1;
    private _pressVisualActive = false;
    /** 引力范围可视化节点（Graphics 画圆，半径 = gravityRange） */
    private _gravityFieldNode: Node | null = null;
    private readonly _physicsPos = v2();
    /** 公转运动圆心（懒初始化为初始位置反推，保证起点无跳变） */
    private readonly _orbitAnchor = v2();
    /** 当前线速度（世界单位 px/s），供引力弹弓 / 朝向参考 */
    private readonly _linearVel = v2();
    private _orbitElapsed = 0;
    private _orbitInitialized = false;

    onLoad(): void {
        this._resolveBodyNodes();
        this._ensureGravityFieldNode();
        this._cacheBodyPivotBaseScale();
    }

    /**
     * 解析星球视觉层级：star → body(pivot) → spr(visual)。
     * 兼容旧结构 star → body(直接挂 Sprite)。
     */
    private _resolveBodyNodes(): void {
        this._bodyPivot = this.node.getChildByName(BODY_PIVOT_NODE);
        if (this._bodyPivot) {
            this._bodyVisual =
                this._bodyPivot.getChildByName(BODY_VISUAL_NODE) ?? this._bodyPivot;
        } else {
            // 兜底：仅有单层 body
            this._bodyVisual = this.node.getChildByName(BODY_PIVOT_NODE);
            this._bodyPivot = this._bodyVisual;
        }
    }

    /** 记录 body pivot 当前 scale，供按下/松手视觉复位 */
    private _cacheBodyPivotBaseScale(): void {
        this._resolveBodyNodes();
        const pivot = this._bodyPivot;
        if (!pivot) {
            return;
        }
        this._bodyPivotBaseScaleX = pivot.scale.x;
        this._bodyPivotBaseScaleY = pivot.scale.y;
    }

    /**
     * 按逻辑半径设置 spr 缩放；pivot 保持 unit scale，避免与 spr 叠乘导致巨大。
     * 约定：radius 160 ↔ spr.scale 8（44px 贴图 × 8 ≈ 352px 直径）。
     */
    applyVisualScaleForRadius(radius?: number): void {
        this._resolveBodyNodes();
        const visual = this._bodyVisual;
        if (!visual) {
            return;
        }
        const r = radius ?? this.radius;
        const s = r / 20;
        // pivot 只做自转/按压，不参与尺寸
        if (this._bodyPivot && this._bodyPivot !== visual) {
            this._bodyPivot.setScale(1, 1, 1);
        }
        visual.setScale(s, s, 1);
        this.refreshBodyBaseScale();
    }

    /**
     * 圆形点击判定（世界坐标）：点是否落在星球视觉圆内。
     * 圆心取 star 节点世界坐标（= 物理/视觉中心），半径取 spr 视觉世界半径，
     * 与相机移动、分辨率缩放无关，避免矩形 hitTest 四角误触与坐标系错配。
     */
    containsWorldPoint(worldX: number, worldY: number): boolean {
        if (!this.node?.isValid) {
            return false;
        }
        const center = this.node.worldPosition;
        const dx = worldX - center.x;
        const dy = worldY - center.y;
        const hitR = this._visualWorldRadius() * this.bodyHitScale + this.bodyHitPadding;
        return dx * dx + dy * dy <= hitR * hitR;
    }

    /** 星球视觉半径（世界单位）：spr 贴图半径 × 世界缩放；无 spr 时回退逻辑 radius */
    private _visualWorldRadius(): number {
        this._resolveBodyNodes();
        const visual = this._bodyVisual;
        if (visual?.isValid) {
            const ui = visual.getComponent(UITransform);
            if (ui) {
                const half = Math.max(ui.contentSize.width, ui.contentSize.height) * 0.5;
                const ws = visual.worldScale;
                return half * Math.max(Math.abs(ws.x), Math.abs(ws.y));
            }
        }
        return this.radius;
    }

    /** 开始按压视觉：略微缩小 body pivot（含 spr 子树） */
    beginIgnitionPress(): void {
        this._cacheBodyPivotBaseScale();
        this._pressVisualActive = true;
        this.setIgnitionPressVisual(0);
    }

    /**
     * 更新按压/蓄力视觉：chargeRatio ∈ [0,1]，越大缩得越多。
     */
    setIgnitionPressVisual(chargeRatio: number): void {
        const pivot = this._bodyPivot;
        if (!pivot || !this._pressVisualActive) {
            return;
        }
        const t = Math.min(1, Math.max(0, chargeRatio));
        const scaleMul = this.pressBodyScale + (this.chargeBodyScale - this.pressBodyScale) * t;
        pivot.setScale(
            this._bodyPivotBaseScaleX * scaleMul,
            this._bodyPivotBaseScaleY * scaleMul,
            1,
        );
    }

    /** 松手或取消时恢复 body pivot 基准缩放 */
    resetIgnitionPressVisual(): void {
        const pivot = this._bodyPivot;
        if (!pivot) {
            this._pressVisualActive = false;
            return;
        }
        pivot.setScale(this._bodyPivotBaseScaleX, this._bodyPivotBaseScaleY, 1);
        this._pressVisualActive = false;
    }

    /** spawn / 改 scale 后由 Game 调用，刷新 pivot 基准缩放缓存 */
    refreshBodyBaseScale(): void {
        this._cacheBodyPivotBaseScale();
        if (this._pressVisualActive) {
            this.setIgnitionPressVisual(0);
        }
    }

    /** 根据当前 gravityRange 重绘引力覆盖圆（由 Game 在关卡就绪后统一调用） */
    refreshGravityField(): void {
        if (!this.node?.isValid) {
            return;
        }
        this._ensureGravityFieldNode();
        const fieldNode = this._gravityFieldNode;
        if (!fieldNode) {
            return;
        }

        fieldNode.active = this.showGravityField;
        if (!this.showGravityField) {
            return;
        }

        const ui = fieldNode.getComponent(UITransform)!;
        const gfx = fieldNode.getComponent(Graphics)!;
        const r = Math.max(8, this.gravityRange);
        const diameter = r * 2;

        ui.setContentSize(diameter, diameter);
        ui.setAnchorPoint(0.5, 0.5);
        fieldNode.setPosition(0, 0, 0);

        gfx.clear();
        gfx.fillColor = this.gravityFieldFill;
        gfx.strokeColor = this.gravityFieldStroke;
        gfx.lineWidth = this.gravityFieldLineWidth;
        // 圆心与 star 根节点重合，半径与物理 gravityRange 一致
        gfx.circle(0, 0, r);
        gfx.fill();
        gfx.stroke();
    }

    /**
     * 创建或查找 gravity-field 子节点。
     * 与 body 同级且渲染顺序在 body 之前，保证星球画在引力圈之上；不参与 body 自转。
     */
    private _ensureGravityFieldNode(): void {
        if (!this.node?.isValid) {
            return;
        }
        let fieldNode = this.node.getChildByName(GRAVITY_FIELD_NODE);
        if (!fieldNode) {
            fieldNode = new Node(GRAVITY_FIELD_NODE);
            fieldNode.parent = this.node;
            fieldNode.addComponent(UITransform);
            fieldNode.addComponent(Graphics);
        }

        // siblingIndex 越小越先画：引力圈 0，body pivot 1
        fieldNode.setSiblingIndex(0);
        this._resolveBodyNodes();
        const pivot = this._bodyPivot;
        if (pivot) {
            pivot.setSiblingIndex(1);
        }

        this._gravityFieldNode = fieldNode;
    }

    /** 星球在 game 节点本地坐标系下的物理中心 */
    getPhysicsPosition(out?: Vec2): Vec2 {
        if (!this.node?.isValid) {
            if (out) {
                out.set(this._physicsPos);
                return out;
            }
            return this._physicsPos;
        }
        const p = this.node.position;
        this._physicsPos.set(p.x, p.y);
        if (out) {
            out.set(this._physicsPos);
            return out;
        }
        return this._physicsPos;
    }

    /** 节点是否仍可参与物理 / 渲染 */
    isAlive(): boolean {
        return !!this.node?.isValid;
    }

    /**
     * 起始星公转切向符号（与自转同向，仅 initPlayerOrbit / 起始星公转维持使用）。
     * - rotationSpeed > 0：CCW → +1
     * - rotationSpeed < 0：CW → −1
     */
    getPreferredOrbitSign(): number | null {
        if (this.rotationSpeed > 0) {
            return 1;
        }
        if (this.rotationSpeed < 0) {
            return -1;
        }
        return null;
    }

    /** 是否为运动天体（参与引力弹弓） */
    isMoving(): boolean {
        return this.orbitalRadius > 0 && this.orbitalAngularSpeed !== 0;
    }

    /**
     * 推进天体公转运动（由 PhysicsManager 在每个固定物理步调用）。
     * 绕圆心匀速画圆，圆心由首次调用时的位置与相位反推，保证起点无位置跳变。
     */
    tickOrbitalMotion(dt: number): void {
        if (!this.isMoving() || !this.node?.isValid) {
            return;
        }
        const w = (this.orbitalAngularSpeed * Math.PI) / 180;
        const phase = (this.orbitalPhaseDeg * Math.PI) / 180;

        if (!this._orbitInitialized) {
            const p = this.node.position;
            // 反推圆心：使 t=0 时星球正好处于当前位置（圆上），避免初始 R 跳变
            this._orbitAnchor.set(
                p.x - this.orbitalRadius * Math.cos(phase),
                p.y - this.orbitalRadius * Math.sin(phase),
            );
            this._orbitElapsed = 0;
            this._orbitInitialized = true;
        }

        this._orbitElapsed += dt;
        const a = phase + w * this._orbitElapsed;
        const x = this._orbitAnchor.x + this.orbitalRadius * Math.cos(a);
        const y = this._orbitAnchor.y + this.orbitalRadius * Math.sin(a);
        const z = this.node.position.z;
        this.node.setPosition(x, y, z);

        // 圆周运动线速度 = d/dt[anchor + R(cos a, sin a)] = R·w·(-sin a, cos a)
        this._linearVel.set(
            -this.orbitalRadius * w * Math.sin(a),
            this.orbitalRadius * w * Math.cos(a),
        );
    }

    /** 当前线速度（px/s）；静止天体为 (0,0) */
    getLinearVelocity(out?: Vec2): Vec2 {
        if (out) {
            out.set(this._linearVel);
            return out;
        }
        return this._linearVel;
    }

    update(dt: number): void {
        // 自转施加在 body pivot 上，spr 随 pivot 旋转
        if (this._bodyPivot && this.rotationSpeed !== 0) {
            const z = this._bodyPivot.eulerAngles.z + this.rotationSpeed * dt;
            this._bodyPivot.setRotationFromEuler(0, 0, z);
        }
    }
}
