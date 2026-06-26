import { _decorator, Component, Vec3, v3 } from 'cc';
import { Star, IGravitationTarget } from './Star';

const { ccclass, property } = _decorator;

/**
 * 玩家：受星球引力影响的可控物体。
 * 挂载到玩家节点后，会自动注册到场景中所有 Star，由 Star 统一施加引力。
 */
@ccclass('Player')
export class Player extends Component implements IGravitationTarget {
    /** 物体自身质量（当前引力公式中仅 Star 质量参与加速度计算，保留供后续扩展） */
    @property({ tooltip: '物体质量' })
    mass = 1;

    /** 物体碰撞半径，用于地表约束时与星球半径叠加 */
    @property({ tooltip: '物体碰撞半径，用于地表约束' })
    bodyRadius = 0;

    /** 当前速度（世界坐标） */
    velocity: Vec3 = v3();

    /** 已挣脱引力的星球集合 */
    escapedStars = new Set<Star>();

    /** 当前贴地附着的星球，null 表示在空中 */
    groundedStar: Star | null = null;

    /** 触地后收拢进度 [0,1] */
    groundSettleProgress = 1;

    onEnable() {
        this.escapedStars.clear();
        this.groundedStar = null;
        this.groundSettleProgress = 1;
        for (const star of Star.instances) {
            star.registerBody(this);
        }
    }

    onDisable() {
        this.groundedStar = null;
        for (const star of Star.instances) {
            star.unregisterBody(this);
        }
        this.escapedStars.clear();
    }

    /** 标记已从指定星球挣脱，后续不再受该星球引力影响 */
    markEscaped(star: Star) {
        this.escapedStars.add(star);
        if (this.groundedStar === star) {
            this.groundedStar = null;
            this.groundSettleProgress = 1;
        }
    }

    /** 重新进入引力范围时清除逃逸标记 */
    clearEscape(star: Star) {
        this.escapedStars.delete(star);
    }

    /** 设置贴地状态（不改变节点父级；新触地时启动收拢过渡） */
    setGrounded(star: Star | null) {
        if (star !== null && this.groundedStar === null) {
            this.groundSettleProgress = 0;
        }
        if (star === null) {
            this.groundSettleProgress = 1;
        }
        this.groundedStar = star;
    }

    /** 重置逃逸状态，重新受所有星球引力影响 */
    resetEscape() {
        this.escapedStars.clear();
    }

    /** 给物体一个初始速度（例如发射、弹射） */
    setVelocity(velocity: Vec3) {
        this.velocity.set(velocity);
    }

    /** 在当前速度基础上叠加冲量 */
    addImpulse(impulse: Vec3) {
        this.velocity.add(impulse);
    }
}
