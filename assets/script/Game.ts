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
    v3,
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

    @property({ tooltip: '出界判定额外边距（px），在 game 节点矩形外再留一点缓冲' })
    boundsFailMargin = 0;

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
    /** 反转公转方向的防抖冷却（秒），>0 时忽略反向输入 */
    private _orbitReverseCooldown = 0;
    /** 触摸点世界坐标缓存（屏幕→世界换算复用，避免每次点击新建） */
    private readonly _touchWorld = v3();

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
            if (this._orbitReverseCooldown > 0) {
                this._orbitReverseCooldown = Math.max(0, this._orbitReverseCooldown - dt);
            }
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
        this._orbitReverseCooldown = 0;
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

        // 尺寸只调 spr，body pivot 保持 1，避免与 spr 叠乘
        star.applyVisualScaleForRadius(def.radius);
        return star;
    }

    /** 飞船飞出 game 矩形则失败；仅自由飞行态判定，点火后有宽限期 */
    private _checkOutOfBounds(): void {
        const player = this.player;
        if (!player || this._phase !== GamePhase.Playing) {
            return;
        }
        if (player.flightMode !== FlightMode.FreeFlight) {
            return;
        }
        if (player.outOfBoundsGrace > 0) {
            return;
        }

        const { halfW, halfH, width, height } = this._getGameBounds();
        const margin = player.getLogicRadius() + this.boundsFailMargin;
        const { x, y } = player.physicsPos;

        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            x < -halfW - margin ||
            x > halfW + margin ||
            y < -halfH - margin ||
            y > halfH + margin
        ) {
            console.warn(
                `[Game] 出界 pos=(${x.toFixed(1)}, ${y.toFixed(1)}) bounds=${width}×${height}`,
            );
            this._onLevelFailed('out_of_bounds');
        }
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
        const camera = this.followCamera;
        if (!player || !camera) {
            return;
        }

        // 触摸屏幕坐标 → 世界坐标（考虑相机移动/缩放），用于圆形命中判定
        const loc = event.getLocation();
        camera.screenToWorld(v3(loc.x, loc.y, 0), this._touchWorld);
        const host = player.getIgniteHost();

        // 按住星球本体：蓄力点火
        if (host?.isAlive() && host.containsWorldPoint(this._touchWorld.x, this._touchWorld.y)) {
            this._chargeTouchId = event.getID();
            this._chargeStar = host;
            this._chargeElapsed = 0;
            host.beginIgnitionPress();

            console.log(
                `[Game] 按住星球 ${host.node.name} 蓄力 | flightMode=${FlightMode[player.flightMode]}`,
            );
            return;
        }

        // 点击星球外：反转公转方向（公转态或软入轨后期），带最小间隔防抖
        if (this._orbitReverseCooldown <= 0 && this._physics.reverseOrbitDirection(player)) {
            this._orbitReverseCooldown = player.orbitReverseMinInterval;
            const dir = player.orbitDirectionSign === 1 ? 'CCW' : 'CW';
            console.log(`[Game] 公转反向 → ${dir}`);
        }
    }

    private _onTouchEnd(event: EventTouch): void {
        if (event.getID() !== this._chargeTouchId) {
            return;
        }
        this._releaseIgnitionCharge();
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
        this._chargeStar.setIgnitionPressVisual(this._getChargeRatio());
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
            return;
        }

        const host = player.getIgniteHost();
        if (host !== star) {
            console.warn('[Game] 点火取消：宿主已变化');
            return;
        }

        const ratio = Math.min(1, elapsed / Math.max(0.001, player.chargeMaxDuration));
        const impulse = player.computeIgnitionImpulse(ratio);
        const ignited = this._physics.ignitePlayer(impulse);

        if (ignited) {
            console.log(
                `[Game] 松手点火成功 | charge=${(ratio * 100).toFixed(0)}% impulse=${impulse.toFixed(0)}`,
            );
        } else {
            console.warn('[Game] 松手点火失败');
        }
    }

    /** 取消蓄力（不点火）；restoreVisual 为 true 时恢复星球缩放 */
    private _cancelIgnitionCharge(restoreVisual: boolean): void {
        if (restoreVisual) {
            this._chargeStar?.resetIgnitionPressVisual();
        }
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
