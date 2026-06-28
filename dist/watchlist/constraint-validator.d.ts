import type { ConstraintViolation, RebalancePlan, RebalanceConstraints, ValidationResult, StockReport } from "./rebalance-types";
export interface ValidationContext {
    sectors: Map<string, string>;
    /** held 持仓信息：locked（<anti_churn_days）+ stopLossSignal（止损信号，可突破锁）
     *  + takeProfitSignal（止盈信号：浮盈≥阈值，可突破锁卖出，落袋为安不是 churn） */
    held: Map<string, {
        days_held: number;
        locked: boolean;
        stopLossSignal?: boolean;
        takeProfitSignal?: boolean;
    }>;
    tickersInPool: Set<string>;
    recentSoldTickers?: Set<string>;
    /** ticker → fitness score（shallow-analyzer 产物）。用于规则 11：fitness<7 禁止 BUY/ADD。 */
    fitnessByTicker?: Map<string, number>;
}
export declare function validateRebalance(plan: RebalancePlan, ctx: ValidationContext, c: RebalanceConstraints): ValidationResult;
/** revise 反馈的可选上下文：给 LLM 更具体的修正指引。
 *  - overSectors：超限行业集合（从违规 detail 解析），用于告诉 LLM "别再往这些行业加仓"
 *  - reports：候选股报告，用于筛出"非超限行业的强标的"推荐给 LLM 转向
 *
 *  这是阶段 13 的核心：候选池偏科时（如电子占 60%），LLM 撞行业上限后不会转向，
 *  死磕同行业。给它具体的非超限行业强标的清单（如中科曙光/巨化股份），它才有出路。 */
export interface FeedbackContext {
    overSectors?: Set<string>;
    reports?: StockReport[];
}
/** 把 violations 拼成 LLM revise 用的 feedback 字符串。空 violations 返回空。
 *  关键：不只是报错，还要给可执行的修正指引——否则 LLM 不知道该砍哪个动作，盲目重试
 *  往往收敛不了（这正是之前满仓卡死时 revise 2 次仍失败的原因之一）。 */
export declare function composeReviseFeedback(violations: ConstraintViolation[], ctx?: FeedbackContext): string;
//# sourceMappingURL=constraint-validator.d.ts.map