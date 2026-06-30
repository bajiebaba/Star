import {
    _decorator,
    Camera,
    Component,
    EventTouch,
    input,
    Input,
    instantiate,
    Layers,
    Node,
    UITransform,
    v2,
} from 'cc';
import { Math2D } from './core/Math2D';
import { OrientationManager } from './core/OrientationManager';
import { StarFieldGenerator, type StarSpawnDef } from './core/StarFieldGenerator';
import { PhysicsManager } from './PhysicsManager';
import { FlightMode, Player } from './Player';
import { Star } from './Star';

const { ccclass, property } = _decorator;

/** 关卡运行状态 */
enum GamePhase {
    Playing = 0,
    Failed = 1,
}

/**
 * 关卡入口：M0 物理原型。
 * 驱动 PhysicsManager、程序化星图、输入点火、出界失败、相机平滑跟随。
 */
@ccclass('Game')
export class Game extends Component {
    @property(Player)
    player: Player | null = null;

    @property(Camera)
    followCamera: Camera | null = null;

    @property({ tooltip: '相机跟随平滑时间（秒）' })
    cameraSmoothTime = 0.28;

    @property({ tooltip: '竖屏相对横屏的视口缩放' })
    portraitScale = 1.08;

    @property({ tooltip: '星图随机种子（相同 seed 生成相同布局）' })
    starFieldSeed = 20260629;

    @property({ tooltip: '期望星球数量；0 表示按 game 区域面积自动估算' })
    starFieldTargetCount = 0;

    @property({ tooltip: '运动天体（引力弹弓）占比 [0,1]；0 = 全部静止' })
    movingStarRatio = 0.3;

    @property({ tooltip: '出界判定额外边距（px），在 game 节点矩形外再留一点缓冲' })
    boundsFailMargin = 0;

    @property({ tooltip: '抬手位置距按下位置超过此像素（UI 坐标）则取消点火' })
    ignitionCancelDistance = 200;

    @property({ tooltip: '蓄力中拖拽超过此像素（UI 坐标）才参与公转方向判定' })
    orbitDragThreshold = 10;

    @property({ tooltip: '公转方向拖拽径向死区：|sin(A−B)| 低于此值（拖拽接近径向）时不切换方向，防抖动' })
    orbitDragDeadzone = 0.26;

    private readonly _physics = new PhysicsManager();
    private readonly _renderPos = v2();
    private readonly _cameraVel = { value: 0 };
    private readonly _cameraVelY = { value: 0 };
    private _orientation: OrientationManager | null = null;
    private _stars: Star[] = [];
    private _phase = GamePhase.Playing;

    /** 蓄力点火：当前按住的 touch id（-1 表示无） */
    private _chargeTouchId = -1;
    /** 蓄力目标星球（必须是 getIgniteHost()） */
    private _chargeStar: Star | null = null;
    /** 自按下起的蓄力时长（秒） */
    private _chargeElapsed = 0;
    /** 按下时的 UI 坐标（用于抬手取消距离判定 / 拖拽控制公转方向） */
    private readonly _chargeStartUI = v2();
    /** 拖拽已设定的公转方向符号（0=未设 / +1=CCW 偏左 / −1=CW 偏右） */
    private _dragOrbitSign = 0;
    /** 冲量阶段：点火后进度条改为表示冲量剩余，直到完全被捕获 */
    private _impulsePhase = false;
    /** 点火时的蓄力值（冲量阶段进度条初值，无缝衔接） */
    private _igniteChargeRatio = 0;

    onLoad(): void {
        if (!this.followCamera) {
            this.followCamera =
                this.node.parent?.getChildByName('Camera')?.getComponent(Camera) ?? null;
        }
        this._resolvePlayer();
        this._bindInput();
        this._setupOrientation();
    }

    start(): void {
        // start 阶段再初始化关卡，确保 Star / Player 的 onLoad 已完成
        this._setupLevel();
    }

    update(dt: number): void {
        if (this._phase === GamePhase.Playing) {
            this._physics.tick(dt);
            this._updateIgnitionCharge(dt);
            this._updateImpulseGauge();
            this._checkOutOfBounds();
        }

        if (!this.player) {
            return;
        }
        this.player.applyRender(this._physics.alpha, this._renderPos, dt);
        // 每帧保持飞船在最上层（动态生成的星球可能排在后面）
        this.player.node.setSiblingIndex(this.node.children.length - 1);
        this._followCamera(dt);
    }

    onDestroy(): void {
        input.off(Input.EventType.TOUCH_START, this._onTouchStart, this);
        input.off(Input.EventType.TOUCH_MOVE, this._onTouchMove, this);
        input.off(Input.EventType.TOUCH_END, this._onTouchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this._onTouchEnd, this);
        this.unschedule(this._refreshGravityFieldBatch);
    }

    /** 优先使用编辑器绑定，否则按节点名查找 */
    private _resolvePlayer(): void {
        if (!this.player) {
            this.player = this.node.getChildByName('player')?.getComponent(Player) ?? null;
        }
    }

    private _setupLevel(): void {
        this._phase = GamePhase.Playing;
        this._cancelIgnitionCharge(true);
        this._physics.reset();
        this._resolvePlayer();

        const mainPlayerNode = this.player?.node ?? this.node.getChildByName('player');
        if (mainPlayerNode) {
            mainPlayerNode.active = true;
        }

        // 只禁用 player-001 / player-002，不能用 startsWith('player')（会把主节点也关掉）
        for (const child of this.node.children) {
            if (child !== mainPlayerNode && /^player-\d+$/.test(child.name)) {
                child.active = false;
            }
        }

        this._clearGeneratedStars();
        const templateStar = this.node.getChildByName('star')?.getComponent(Star) ?? null;
        const spawnedStars = this._spawnStarField();
        this._stars = this._collectActiveStars(templateStar, spawnedStars);

        for (const star of this._stars) {
            this._physics.registerStar(star);
            this._ensureVisibleLayer(star.node);
        }
        // 分帧绘制引力圈，避免 50+ Graphics 同帧卡死主线程
        this._scheduleGravityFieldRefresh();

        if (this.player) {
            this._ensureVisibleLayer(this.player.node);
            this.player.outOfBoundsGrace = 0;
            // 飞船始终绘制在星球之上，避免被后渲染的星球遮挡
            this.player.node.setSiblingIndex(this.node.children.length - 1);
            this._physics.registerPlayer(this.player);
            const startStar = this._stars.find((s) => s.isStartStar) ?? this._stars[0];
            if (startStar) {
                startStar.isStartStar = true;
                this._physics.initPlayerOrbit(this.player, startStar, 40);
                // 首帧立即同步位置，避免第一帧看不到飞船
                this.player.applyRender(1, this._renderPos, 0);
                this._snapCameraToPlayer();
            }
        }
    }

    /** 收集当前有效星球：起始星 + 本关新生成，不依赖 getComponentsInChildren（destroy 延迟） */
    private _collectActiveStars(templateStar: Star | null, spawned: Star[]): Star[] {
        const stars: Star[] = [];
        if (templateStar?.isAlive()) {
            stars.push(templateStar);
        }
        for (const star of spawned) {
            if (star.isAlive() && stars.indexOf(star) < 0) {
                stars.push(star);
            }
        }
        return stars;
    }

    /** 移除上次运行时生成的 star-N 节点，保留模板 star */
    private _clearGeneratedStars(): void {
        for (const child of [...this.node.children]) {
            if (!/^star-\d+$/.test(child.name)) {
                continue;
            }
            const star = child.getComponent(Star);
            if (star) {
                this._physics.unregisterStar(star);
            }
            child.removeFromParent();
            child.destroy();
        }
    }

    /** 读取 game 节点 UITransform 矩形，作为星图与出界判定的统一边界 */
    private _getGameBounds(): { halfW: number; halfH: number; width: number; height: number } {
        const ui = this.node.getComponent(UITransform);
        const rawW = ui?.contentSize.width ?? 0;
        const rawH = ui?.contentSize.height ?? 0;
        // contentSize 为 0 时回退到场景设计尺寸，避免误判出界
        const width = rawW > 1 ? rawW : 2250;
        const height = rawH > 1 ? rawH : 4002;
        return { halfW: width * 0.5, halfH: height * 0.5, width, height };
    }

    /** 按 game 节点范围程序化铺满星球，返回本关新生成的 Star 列表 */
    private _spawnStarField(): Star[] {
        const template = this.node.getChildByName('star');
        if (!template) {
            return [];
        }

        const { halfW, halfH, width, height } = this._getGameBounds();
        const startStar = template.getComponent(Star);
        const defs = StarFieldGenerator.generate(width, height, {
            seed: this.starFieldSeed,
            targetCount: this.starFieldTargetCount,
            startStarRadius: startStar?.radius ?? 160,
            startStarGravityRange: startStar?.gravityRange,
            movingStarRatio: this.movingStarRatio,
        });

        console.log(`[Game] 生成星球 ${defs.length} 颗，game 范围 ${width}×${height}`);

        const spawned: Star[] = [];
        for (const def of defs) {
            const star = this._spawnStarFromDef(template, def);
            if (star) {
                spawned.push(star);
            }
        }
        return spawned;
    }

    /** 分帧刷新引力可视化，减轻首帧 769ms 卡顿 */
    private _scheduleGravityFieldRefresh(): void {
        this.unschedule(this._refreshGravityFieldBatch);
        this._gravityRefreshQueue = [...this._stars];
        this.schedule(this._refreshGravityFieldBatch, 0.016);
    }

    private _gravityRefreshQueue: Star[] = [];

    private _refreshGravityFieldBatch = (): void => {
        const batch = 6;
        for (let i = 0; i < batch && this._gravityRefreshQueue.length > 0; i++) {
            const star = this._gravityRefreshQueue.shift();
            if (star?.isAlive()) {
                star.refreshGravityField();
            }
        }
        if (this._gravityRefreshQueue.length === 0) {
            this.unschedule(this._refreshGravityFieldBatch);
        }
    };

    /** Canvas 下使用 UI_2D 层，确保 Camera 能渲染 */
    private _ensureVisibleLayer(root: Node): void {
        const layer = Layers.Enum.UI_2D;
        root.walk((node) => {
            node.layer = layer;
        });
    }

    /** 从模板实例化一颗星球并应用配置 */
    private _spawnStarFromDef(template: Node, def: StarSpawnDef): Star | null {
        const starNode = instantiate(template);
        starNode.name = def.name;
        starNode.setPosition(def.x, def.y, 0);
        starNode.parent = this.node;

        const star = starNode.getComponent(Star);
        if (!star) {
            return null;
        }

        star.radius = def.radius;
        star.mass = def.mass;
        star.gravityRange = def.gravityRange;
        star.gravityConstant = 100;
        star.rotationSpeed = def.rotationSpeed;
        star.isStartStar = false;
        star.orbitMinAltitude = def.orbitMinAltitude;
        // 引力弹弓：运动天体参数（0 表示静止）
        star.orbitalAngularSpeed = def.orbitalAngularSpeed;
        star.orbitalRadius = def.orbitalRadius;
        star.orbitalPhaseDeg = def.orbitalPhaseDeg;

        // 尺寸只调 spr，body pivot 保持 1，避免与 spr 叠乘
        star.applyVisualScaleForRadius(def.radius);
        return star;
    }

    /**
     * 飞船飞出 game 矩形则环绕传送（不再失败）：
     * - 左右出界 → x 传到对边，y 取互补（−y，中心对称）
     * - 上下出界 → y 传到对边，x 取互补（−x）
     * - 角点同时出界 → 两轴都传到对边（中心对称到对角）
     * 速度保持不变；仅惯性飞行态判定。
     */
    private _checkOutOfBounds(): void {
        const player = this.player;
        if (!player || this._phase !== GamePhase.Playing) {
            return;
        }
        if (player.flightMode !== FlightMode.FreeFlight) {
            return;
        }

        let { x, y } = player.physicsPos;

        // 异常坐标兜底（极端情况）：判失败重试，避免 NaN/Infinity 污染物理
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            this._onLevelFailed('invalid_position');
            return;
        }

        const { halfW, halfH } = this._getGameBounds();
        const xOut = x < -halfW || x > halfW;
        const yOut = y < -halfH || y > halfH;
        if (!xOut && !yOut) {
            return;
        }

        if (xOut && yOut) {
            // 角点：两轴都传到对边（中心对称到对角）
            x = x < 0 ? halfW : -halfW;
            y = y < 0 ? halfH : -halfH;
        } else if (xOut) {
            // 左右出界：x 传对边，y 取互补
            x = x < 0 ? halfW : -halfW;
            y = -y;
        } else {
            // 上下出界：y 传对边，x 取互补
            y = y < 0 ? halfH : -halfH;
            x = -x;
        }

        player.physicsPos.set(x, y);
        // 速度不变；同步上一帧状态，避免渲染插值画出横跨屏幕的拉线
        player.syncRenderState();
        // 相机直接对准新位置，避免平滑跟随划过整个场景
        this._renderPos.set(x, y);
        this._snapCameraToPlayer();

        console.log(`[Game] 环绕传送 → (${x.toFixed(1)}, ${y.toFixed(1)})`);
    }

    private _onLevelFailed(reason: string): void {
        if (this._phase === GamePhase.Failed) {
            return;
        }
        this._phase = GamePhase.Failed;
        this._cancelIgnitionCharge(false);
        console.warn(`[Game] 关卡失败：${reason}（点击屏幕重试）`);
    }

    private _bindInput(): void {
        input.on(Input.EventType.TOUCH_START, this._onTouchStart, this);
        input.on(Input.EventType.TOUCH_MOVE, this._onTouchMove, this);
        input.on(Input.EventType.TOUCH_END, this._onTouchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this._onTouchEnd, this);
    }

    private _onTouchStart(event: EventTouch): void {
        if (this._phase === GamePhase.Failed) {
            console.log('[Game] 重试关卡');
            this._setupLevel();
            return;
        }

        if (this._chargeTouchId >= 0) {
            return;
        }

        const player = this.player;
        if (!player) {
            return;
        }

        // 任意位置点击均可触发蓄力，但需处于可点火状态（公转 / 软入轨后期）
        const host = player.getIgniteHost();
        if (!host?.isAlive()) {
            return;
        }

        const ui = event.getUILocation();
        this._chargeTouchId = event.getID();
        this._chargeStar = host;
        this._chargeElapsed = 0;
        this._chargeStartUI.set(ui.x, ui.y);
        this._dragOrbitSign = 0;
        this._impulsePhase = false;
        host.beginIgnitionPress();
        player.showChargeProgress(0);

        console.log(
            `[Game] 蓄力开始 | host=${host.node.name} flightMode=${FlightMode[player.flightMode]}`,
        );
    }

    /**
     * 拖拽控制公转方向：
     * A = 拖拽向量（当前手指 − 按下点），B = 飞船相对宿主星方位（径向）。
     * 拖拽方向贴近哪个切向就朝那边公转 —— 用叉积符号 sign(径向 × 拖拽) = sign(sin(A−B)) 判定。
     */
    private _onTouchMove(event: EventTouch): void {
        const player = this.player;
        if (event.getID() !== this._chargeTouchId || !player) {
            return;
        }
        const host = this._chargeStar;
        if (!host?.isAlive()) {
            return;
        }

        // A：拖拽向量（UI 坐标；相机不旋转，方向轴与世界一致）
        const ui = event.getUILocation();
        const dx = ui.x - this._chargeStartUI.x;
        const dy = ui.y - this._chargeStartUI.y;
        const dragLen = Math.sqrt(dx * dx + dy * dy);
        if (dragLen < this.orbitDragThreshold) {
            return;
        }

        // B：飞船相对宿主星方位（径向）
        const starPos = host.getPhysicsPosition();
        const rx = player.physicsPos.x - starPos.x;
        const ry = player.physicsPos.y - starPos.y;
        const rLen = Math.sqrt(rx * rx + ry * ry);
        if (rLen < 1e-3) {
            return;
        }

        // 归一化叉积 = sin(A−B)：>0 拖拽偏 CCW 切向，<0 偏 CW；接近 0（拖拽近径向）为死区，保持当前方向
        const nc = (rx * dy - ry * dx) / (rLen * dragLen);
        if (Math.abs(nc) < this.orbitDragDeadzone) {
            return;
        }
        const sign = nc > 0 ? 1 : -1;
        if (sign !== this._dragOrbitSign && this._physics.setOrbitDirection(player, sign)) {
            this._dragOrbitSign = sign;
            console.log(`[Game] 拖拽公转方向 → ${sign === 1 ? 'CCW' : 'CW'}`);
        }
    }

    private _onTouchEnd(event: EventTouch): void {
        if (event.getID() !== this._chargeTouchId) {
            return;
        }

        // 抬手位置距按下位置超过阈值 → 取消点火
        const ui = event.getUILocation();
        const dx = ui.x - this._chargeStartUI.x;
        const dy = ui.y - this._chargeStartUI.y;
        const moved = Math.sqrt(dx * dx + dy * dy);

        if (moved > this.ignitionCancelDistance) {
            this._cancelIgnitionCharge(true);
            console.log(
                `[Game] 抬手距按下点 ${moved.toFixed(0)}px > ${this.ignitionCancelDistance}，点火取消`,
            );
        } else {
            this._releaseIgnitionCharge();
        }
    }

    /** 蓄力进度 [0,1] */
    private _getChargeRatio(): number {
        const player = this.player;
        if (!player || player.chargeMaxDuration <= 0) {
            return 1;
        }
        return Math.min(1, this._chargeElapsed / player.chargeMaxDuration);
    }

    private _updateIgnitionCharge(dt: number): void {
        if (this._chargeTouchId < 0 || !this._chargeStar) {
            return;
        }

        const player = this.player;
        const host = player?.getIgniteHost();
        // 飞行态变化（不应发生）或宿主切换时取消蓄力
        if (!player || !host || host !== this._chargeStar) {
            this._cancelIgnitionCharge(false);
            return;
        }

        this._chargeElapsed += dt;
        const ratio = this._getChargeRatio();
        this._chargeStar.setIgnitionPressVisual(ratio);
        player.showChargeProgress(ratio);
    }

    /** 松手：按蓄力冲量点火 */
    private _releaseIgnitionCharge(): void {
        const star = this._chargeStar;
        const player = this.player;
        const elapsed = this._chargeElapsed;

        this._chargeTouchId = -1;
        this._chargeStar = null;
        this._chargeElapsed = 0;
        star?.resetIgnitionPressVisual();

        if (!player || !star) {
            player?.hideChargeProgress();
            return;
        }

        const host = player.getIgniteHost();
        if (host !== star) {
            console.warn('[Game] 点火取消：宿主已变化');
            player.hideChargeProgress();
            return;
        }

        const ratio = Math.min(1, elapsed / Math.max(0.001, player.chargeMaxDuration));
        const impulse = player.computeIgnitionImpulse(ratio);
        const ignited = this._physics.ignitePlayer(impulse);

        if (ignited) {
            // 切入冲量阶段：进度条不隐藏，初值=蓄力值（无缝），随后表示冲量剩余
            this._impulsePhase = true;
            this._igniteChargeRatio = ratio;
            player.showChargeProgress(ratio);
            console.log(
                `[Game] 松手点火成功 | charge=${(ratio * 100).toFixed(0)}% impulse=${impulse.toFixed(0)}`,
            );
        } else {
            player.hideChargeProgress();
            console.warn('[Game] 松手点火失败');
        }
    }

    /**
     * 冲量阶段：点火后进度条改为表示「冲量剩余」。
     * 剩余 = 点火蓄力值 × clamp01(当前速度 / 点火初速度)，随引力减速自然下降；
     * 飞船完全被捕获（进入稳定公转 Orbiting）时归 0 并隐藏。
     */
    private _updateImpulseGauge(): void {
        if (!this._impulsePhase) {
            return;
        }
        const player = this.player;
        if (!player) {
            this._impulsePhase = false;
            return;
        }

        // 完全被捕获（稳定公转）→ 归 0 并隐藏
        if (player.flightMode === FlightMode.Orbiting) {
            this._impulsePhase = false;
            player.showChargeProgress(0);
            player.hideChargeProgress();
            return;
        }

        // 自由飞行 / 软入轨过渡：按 当前速度 / 点火初速度 比例衰减
        const speed = Math.sqrt(
            player.physicsVel.x * player.physicsVel.x +
                player.physicsVel.y * player.physicsVel.y,
        );
        const base = player.igniteSpeed > 1e-3 ? player.igniteSpeed : 1;
        const remaining = this._igniteChargeRatio * Math.min(1, Math.max(0, speed / base));
        player.showChargeProgress(remaining);
    }

    /** 取消蓄力（不点火）；restoreVisual 为 true 时恢复星球缩放 */
    private _cancelIgnitionCharge(restoreVisual: boolean): void {
        if (restoreVisual) {
            this._chargeStar?.resetIgnitionPressVisual();
        }
        this._impulsePhase = false;
        this.player?.hideChargeProgress();
        this._chargeTouchId = -1;
        this._chargeStar = null;
        this._chargeElapsed = 0;
    }

    private _setupOrientation(): void {
        const canvas = this.node.parent;
        if (!canvas) {
            return;
        }
        this._orientation = canvas.getComponent(OrientationManager);
        if (!this._orientation && this.followCamera) {
            this._orientation = canvas.addComponent(OrientationManager);
            this._orientation.camera = this.followCamera;
            this._orientation.portraitScale = this.portraitScale;
        }
    }

    /** 首帧把相机对准飞船（game 本地坐标） */
    private _snapCameraToPlayer(): void {
        const camNode = this.followCamera?.node;
        if (!camNode) {
            return;
        }
        camNode.setPosition(this._renderPos.x, this._renderPos.y, camNode.position.z);
        this._cameraVel.value = 0;
        this._cameraVelY.value = 0;
    }

    /**
     * 相机阻尼跟随飞船。
     * 使用 game 本地坐标（与物理一致），避免 Canvas 下 worldPosition 换算偏差。
     */
    private _followCamera(dt: number): void {
        const camNode = this.followCamera?.node;
        if (!camNode) {
            return;
        }

        const tx = this._renderPos.x;
        const ty = this._renderPos.y;
        const cx = camNode.position.x;
        const cy = camNode.position.y;
        const nx = Math2D.smoothDamp(cx, tx, this._cameraVel, this.cameraSmoothTime, dt);
        const ny = Math2D.smoothDamp(cy, ty, this._cameraVelY, this.cameraSmoothTime, dt);
        camNode.setPosition(nx, ny, camNode.position.z);
    }
}
