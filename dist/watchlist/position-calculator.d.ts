import type { ActionType, RebalanceConstraints, RebalancePlan, StockReport } from "./rebalance-types";
/** action 类型 → priority（execution-planner 排序用）。
 *  SELL=1（先释放资金）→ REDUCE=2 → BUY=3 → ADD=4 → HOLD=5（最后）。
 *  与 rebalance-types.ts Action.priority 注释一致。 */
export declare function actionPriority(action: ActionType): number;
/** fitness 分数 → 基础仓位（折扣前）。
 *  趋势模式线性映射：fitness 全程有仓位，无"≤6 不买"断崖。
 *  每分 0.8%：fit3→2.4%, fit5→4%, fit7→5.6%, fit9→7.2%, fit10→8%。
 *  受 singleNameCap（默认 10%）钳制。 */
export declare function baseWeight(fitness: number): number;
/** 波动率折扣：日线收益率标准差（单位 %，如 2.5 = 2.5%/日，由 computeVolatility 输出）。
 *  0（kline 失败/未知）→ ×0.6（最保守折扣，防"零风险"假象）。
 *  <2%/日 → ×1.0（大盘股），2-4% → ×0.8（成长股），>4% → ×0.6（题材/次新）。 */
export declare function volatilityFactor(volatility: number): number;
/** 趋势模式已移除 riskFactor——risk=high 靠技术位止损（risk prompt 输出退出信号
 *  → rebalancer 触发 SELL/REDUCE），不靠仓位压缩。保留导出以避免下游 import 断裂
 *  （返回固定 1.0，语义为"risk 不打折仓位"）。 */
export declare function riskFactor(_overallRisk: "low" | "medium" | "high"): number;
export interface PositionInput {
    action: ActionType;
    report: StockReport;
    currentWeight: number;
    volatility: number;
    singleNameCap: number;
    /** 建仓价（持仓股的 Position.entry_price）。候选股无此字段。 */
    entryPrice?: number;
    /** 当前收盘价（StockData.kline.last_close）。 */
    currentPrice?: number;
    /** 持仓天数（selectCandidates 算好的 days_held）。 */
    daysHeld?: number;
    /** 建仓回撤止损阈值（constraints.initial_stop_drawdown，如 0.07 = -7%）。 */
    initialStopDrawdown?: number;
    /** 建仓回撤止损窗口（constraints.initial_stop_days，如 3 天）。 */
    initialStopDays?: number;
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
    /** ticker → entry_price（持仓股的建仓价，候选股无此键） */
    entryPriceByTicker?: Map<string, number>;
    /** ticker → 当前收盘价（StockData.kline.last_close） */
    currentPriceByTicker?: Map<string, number>;
    /** ticker → 持仓天数（selectCandidates 算好的 days_held） */
    daysHeldByTicker?: Map<string, number>;
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