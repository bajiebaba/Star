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

    @property({ tooltip: '点火点击判定：在视觉半径外的额外放宽倍率（小星球建议 ≥1.3）' })
    bodyHitScale = 1.32;

    @property({ tooltip: '点火点击判定：最小 padding（px），并与 radius×0.12 取较大值' })
    bodyHitPadding = 10;

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
    private readonly _hitTestPoint = v2();
    /** 避免每帧重复写 UITransform */
    private _cachedHitDiameter = -1;

    onLoad(): void {
        this._resolveBodyNodes();
        this._ensureGravityFieldNode();
        this._cacheBodyPivotBaseScale();
        this.syncTouchHitArea();
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
        this._cachedHitDiameter = -1;
        this.syncTouchHitArea();
        this.refreshBodyBaseScale();
    }

    /**
     * 同步 body pivot 的 UITransform 为 spr 实际视觉尺寸。
     * 模板克隆的小星球若仍保留 352×352 的旧 contentSize，会导致 hitTest 严重偏移。
     */
    syncTouchHitArea(): boolean {
        this._resolveBodyNodes();
        const pivot = this._bodyPivot;
        const visual = this._bodyVisual;
        if (!pivot || !visual) {
            return false;
        }

        let pivotUi = pivot.getComponent(UITransform);
        if (!pivotUi) {
            pivotUi = pivot.addComponent(UITransform);
        }

        const visualUi = visual.getComponent(UITransform);
        const texHalf = visualUi
            ? Math.max(visualUi.contentSize.width, visualUi.contentSize.height) * 0.5
            : this.radius / Math.max(Math.abs(visual.scale.x), 0.01);
        const sprScale = Math.max(Math.abs(visual.scale.x), Math.abs(visual.scale.y));
        const visualDiameter = texHalf * 2 * sprScale;
        const pad = Math.max(this.bodyHitPadding, this.radius * 0.12);
        const hitDiameter = visualDiameter * this.bodyHitScale + pad * 2;

        if (Math.abs(hitDiameter - this._cachedHitDiameter) > 0.5) {
            pivotUi.setContentSize(hitDiameter, hitDiameter);
            pivotUi.setAnchorPoint(0.5, 0.5);
            this._cachedHitDiameter = hitDiameter;
        }
        return true;
    }

    /**
     * 屏幕 UI 坐标点击判定（与 EventTouch.getUILocation 同系，由引擎 hitTest 处理相机/缩放）。
     */
    hitTestScreen(uiX: number, uiY: number): boolean {
        if (!this.syncTouchHitArea()) {
            return false;
        }
        const pivotUi = this._bodyPivot?.getComponent(UITransform);
        if (!pivotUi) {
            return false;
        }
        this._hitTestPoint.set(uiX, uiY);
        return pivotUi.hitTest(this._hitTestPoint);
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

    update(dt: number): void {
        // 自转施加在 body pivot 上，spr 随 pivot 旋转
        if (this._bodyPivot && this.rotationSpeed !== 0) {
            const z = this._bodyPivot.eulerAngles.z + this.rotationSpeed * dt;
            this._bodyPivot.setRotationFromEuler(0, 0, z);
        }
    }
}
