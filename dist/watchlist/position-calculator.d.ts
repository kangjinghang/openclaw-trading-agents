import type { ActionType, RebalanceConstraints, RebalancePlan, StockReport } from "./rebalance-types";
/** action 类型 → priority（execution-planner 排序用）。
 *  SELL=1（先释放资金）→ REDUCE=2 → BUY=3 → ADD=4 → HOLD=5（最后）。
 *  与 rebalance-types.ts Action.priority 注释一致。 */
export declare function actionPriority(action: ActionType): number;
/** fitness 分数 → 基础仓位（折扣前）。
 *  平衡档：9分→7% / 8分→5% / 7分→3% / ≤6→0%（不买）。
 *  线性插值：8.5分 = 6%（5% + 2% × 0.5）。 */
export declare function baseWeight(fitness: number): number;
/** 波动率折扣：日线收益率标准差（单位 0-1，如 0.025 = 2.5%/日）。
 *  <2%/日 ×1.0（大盘股），2-4% ×0.8（成长股），>4% ×0.6（题材/次新）。 */
export declare function volatilityFactor(volatility: number): number;
/** 风险因子：low ×1.0，medium ×0.6，high ×0.3。
 *  deal_breaker 不在这里返回，由上层强制改 action 为 SELL。 */
export declare function riskFactor(overallRisk: "low" | "medium" | "high"): number;
export interface PositionInput {
    action: ActionType;
    report: StockReport;
    currentWeight: number;
    volatility: number;
    singleNameCap: number;
}
export interface PositionResult {
    /** 最终目标仓位（0-1） */
    targetWeight: number;
    /** 计算溯源，便于复盘和审计（如 "9分基础7% × 波动率0.8 × 风险1.0 = 5.6%"） */
    trace: string;
}
/** 算出单只股票的目标仓位。
 *  纯函数，无副作用，可独立测试。 */
export declare function computePosition(input: PositionInput): PositionResult;
export interface ApplyPositionsContext {
    /** ticker → StockReport（shallow-analyzer 产物） */
    reportsByTicker: Map<string, StockReport>;
    /** ticker → volatility_20d（来自 data-fetcher，StockData.kline） */
    volatilityByTicker: Map<string, number>;
    /** 硬约束（取 single_name 作单仓上限，cash_reserve 作现金下限） */
    constraints: RebalanceConstraints;
    /** 初始现金（holdings.cash_pct），用于现金排队 */
    initialCash: number;
}
/** 改写 plan 的所有 actions：把 LLM 给的 target_weight/delta 替换为公式算出的值。
 *  同时重算 portfolio_after 和 cash_pct，保证 validator 规则 1（权重和=1）通过。
 *
 *  返回新 plan（不改原对象）+ 每只股的计算溯源（便于审计/复盘）。 */
export declare function applyPositions(plan: RebalancePlan, ctx: ApplyPositionsContext): {
    plan: RebalancePlan;
    traces: Map<string, string>;
};
/** 从 reports + volatility 构造 ApplyPositionsContext 的便捷工厂。 */
export declare function buildApplyContext(reports: StockReport[], volatilityByTicker: Map<string, number>, constraints: RebalanceConstraints, initialCash: number): ApplyPositionsContext;
//# sourceMappingURL=position-calculator.d.ts.map