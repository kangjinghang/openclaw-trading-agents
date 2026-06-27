import type { ConstraintViolation, RebalancePlan, RebalanceConstraints, ValidationResult } from "./rebalance-types";
export interface ValidationContext {
    sectors: Map<string, string>;
    /** held 持仓信息：locked（<anti_churn_days）+ stopLossSignal（止损信号，可突破锁） */
    held: Map<string, {
        days_held: number;
        locked: boolean;
        stopLossSignal?: boolean;
    }>;
    tickersInPool: Set<string>;
    recentSoldTickers?: Set<string>;
    /** ticker → fitness score（shallow-analyzer 产物）。用于规则 11：fitness<7 禁止 BUY/ADD。 */
    fitnessByTicker?: Map<string, number>;
}
export declare function validateRebalance(plan: RebalancePlan, ctx: ValidationContext, c: RebalanceConstraints): ValidationResult;
/** 把 violations 拼成 LLM revise 用的 feedback 字符串。空 violations 返回空。 */
export declare function composeReviseFeedback(violations: ConstraintViolation[]): string;
//# sourceMappingURL=constraint-validator.d.ts.map