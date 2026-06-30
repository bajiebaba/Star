/** 程序化生成的单颗星球配置 */
export interface StarSpawnDef {
    name: string;
    x: number;
    y: number;
    radius: number;
    mass: number;
    gravityRange: number;
    rotationSpeed: number;
    orbitMinAltitude: number;
    /** 天体公转角速度（度/秒），0=静止；用于引力弹弓 */
    orbitalAngularSpeed: number;
    /** 天体公转半径（px），0=静止 */
    orbitalRadius: number;
    /** 天体公转初始相位（度） */
    orbitalPhaseDeg: number;
}

export interface StarFieldOptions {
    /** 随机种子，相同种子生成相同星图 */
    seed?: number;
    /** 期望星球数量；0 表示按区域面积自动估算 */
    targetCount?: number;
    minRadius?: number;
    maxRadius?: number;
    /** 星心到 game 边界的最小留白（不含星球自身半径） */
    edgePadding?: number;
    /** 两颗星本体之间的最小间隙 */
    minBodyGap?: number;
    /** 星体与邻星引力圈外缘的额外留白（px），越大越不易「本体进引力圈」 */
    minGravityBodyGap?: number;
    /** 起始星中心与半径，用于预留出生区 */
    startStarX?: number;
    startStarY?: number;
    startStarRadius?: number;
    /** 起始星引力范围；未传则按 startStarRadius 公式估算 */
    startStarGravityRange?: number;
    /** 运动天体（引力弹弓）占比 [0,1]，默认 0.3；0 = 全部静止 */
    movingStarRatio?: number;
    /** 运动天体公转半径范围（px） */
    movingRadiusMin?: number;
    movingRadiusMax?: number;
    /** 运动天体公转角速度大小范围（度/秒，符号随机） */
    movingAngularMin?: number;
    movingAngularMax?: number;
}

/** 轻量确定性 PRNG（mulberry32） */
function createRng(seed: number): () => number {
    let s = seed | 0;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * 在 game 节点矩形范围内程序化撒星。
 * 拒绝采样规则：
 * - 星体互不重叠、不越界
 * - 引力圈之间允许重叠
 * - 尽量避免任一星的本体落入另一颗星的引力范围内
 */
export class StarFieldGenerator {
    /** 与 Star / PhysicsManager 一致的引力半径公式 */
    static computeGravityRange(radius: number): number {
        return Math.round(radius * 2.05 + 55);
    }

    /**
     * 两星允许放置的最小中心距。
     * 取「本体不相撞」「A 本体不在 B 引力圈内」「B 本体不在 A 引力圈内」三者最大值。
     */
    private static _minCenterDistance(
        radiusA: number,
        gravityA: number,
        radiusB: number,
        gravityB: number,
        bodyGap: number,
        gravityBodyGap: number,
    ): number {
        const bodyClear = radiusA + radiusB + bodyGap;
        // 邻星本体需完全在引力圈外，gravityBodyGap 为额外留白
        const bOutsideA = gravityA + radiusB + gravityBodyGap;
        const aOutsideB = gravityB + radiusA + gravityBodyGap;
        return Math.max(bodyClear, bOutsideA, aOutsideB);
    }

    static generate(
        boundsWidth: number,
        boundsHeight: number,
        options: StarFieldOptions = {},
    ): StarSpawnDef[] {
        const rng = createRng(options.seed ?? 20260629);
        const minR = options.minRadius ?? 55;
        const maxR = options.maxRadius ?? 145;
        const edgePad = options.edgePadding ?? 36;
        const bodyGap = options.minBodyGap ?? 48;
        const gravityBodyGap = options.minGravityBodyGap ?? 12;
        const startX = options.startStarX ?? 0;
        const startY = options.startStarY ?? 0;
        const startR = options.startStarRadius ?? 160;
        const startGravity =
            options.startStarGravityRange ?? StarFieldGenerator.computeGravityRange(startR);

        // 引力弹弓：运动天体参数
        const movingRatio = options.movingStarRatio ?? 0.3;
        const movingRMin = options.movingRadiusMin ?? 36;
        const movingRMax = options.movingRadiusMax ?? 50;
        const movingWMin = options.movingAngularMin ?? 40;
        const movingWMax = options.movingAngularMax ?? 75;
        // 间距预留运动余量：运动天体晃动 ±R，预留 2×Rmax 保证运动中本体不重叠
        const movingClearance = movingRatio > 0 ? movingRMax * 2 : 0;
        const effectiveBodyGap = bodyGap + movingClearance;

        const halfW = boundsWidth * 0.5;
        const halfH = boundsHeight * 0.5;
        const area = boundsWidth * boundsHeight;

        // 按面积估算数量；密度减半（除数翻倍 + 上下限减半），星图更稀疏
        let target = options.targetCount ?? 0;
        if (target <= 0) {
            target = Math.floor(area / 350000);
            target = Math.max(16, Math.min(36, target));
        }

        const placed: StarSpawnDef[] = [];
        const maxAttempts = target * 180;
        let attempts = 0;
        let nextId = 2;

        // 两阶段：先严格留白；数量不足时放宽为「刚好不落入引力圈」
        let phaseGravityBodyGap = gravityBodyGap;

        while (placed.length < target && attempts < maxAttempts) {
            attempts++;

            // 阶段切换：严格采样仍不够时，仅保留「本体不进引力圈」硬约束
            if (attempts > target * 100 && phaseGravityBodyGap > 0) {
                phaseGravityBodyGap = 0;
            }

            const radius = minR + (maxR - minR) * rng();
            const newGravity = StarFieldGenerator.computeGravityRange(radius);
            const margin = radius + edgePad;
            if (margin >= halfW || margin >= halfH) {
                continue;
            }

            const x = (rng() * 2 - 1) * (halfW - margin);
            const y = (rng() * 2 - 1) * (halfH - margin);

            // 避开起始星：本体不相撞 + 本体不进起始星引力圈
            const dx0 = x - startX;
            const dy0 = y - startY;
            const startKeep = StarFieldGenerator._minCenterDistance(
                startR,
                startGravity,
                radius,
                newGravity,
                effectiveBodyGap,
                phaseGravityBodyGap,
            );
            if (dx0 * dx0 + dy0 * dy0 < startKeep * startKeep) {
                continue;
            }

            let tooClose = false;
            for (const other of placed) {
                const dx = x - other.x;
                const dy = y - other.y;
                const need = StarFieldGenerator._minCenterDistance(
                    other.radius,
                    other.gravityRange,
                    radius,
                    newGravity,
                    effectiveBodyGap,
                    phaseGravityBodyGap,
                );
                if (dx * dx + dy * dy < need * need) {
                    tooClose = true;
                    break;
                }
            }
            if (tooClose) {
                continue;
            }

            const def = StarFieldGenerator._makeDef(nextId++, x, y, radius, rng);
            // 引力弹弓：按比例让部分星球绕初始位置做圆周运动
            if (movingRatio > 0 && rng() < movingRatio) {
                def.orbitalRadius = Math.round(movingRMin + (movingRMax - movingRMin) * rng());
                const w = movingWMin + (movingWMax - movingWMin) * rng();
                def.orbitalAngularSpeed = Math.round((rng() < 0.5 ? -1 : 1) * w);
                def.orbitalPhaseDeg = Math.round(rng() * 360);
            }
            placed.push(def);
        }

        return placed;
    }

    private static _makeDef(
        id: number,
        x: number,
        y: number,
        radius: number,
        rng: () => number,
    ): StarSpawnDef {
        // 质量 ∝ r²，与现有 M0 手工星图量级一致
        const mass = Math.round(radius * radius * 0.45);
        const gravityRange = StarFieldGenerator.computeGravityRange(radius);
        const rotationSpeed = Math.round((rng() * 2 - 1) * 36);
        const orbitMinAltitude = Math.round(34 + radius * 0.08);

        return {
            name: `star-${id}`,
            x: Math.round(x),
            y: Math.round(y),
            radius: Math.round(radius),
            mass,
            gravityRange,
            rotationSpeed,
            orbitMinAltitude,
            orbitalAngularSpeed: 0,
            orbitalRadius: 0,
            orbitalPhaseDeg: 0,
        };
    }
}
