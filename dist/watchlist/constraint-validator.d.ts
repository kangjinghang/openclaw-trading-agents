import type { ConstraintViolation, RebalancePlan, RebalanceConstraints, ValidationResult } from "./rebalance-types";
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
/** 把 violations 拼成 LLM revise 用的 feedback 字符串。空 violations 返回空。
 *  关键：不只是报错，还要给可执行的修正指引——否则 LLM 不知道该砍哪个动作，盲目重试
 *  往往收敛不了（这正是之前满仓卡死时 revise 2 次仍失败的原因之一）。 */
export declare function composeReviseFeedback(violations: ConstraintViolation[]): string;
//# sourceMappingURL=constraint-validator.d.ts.map