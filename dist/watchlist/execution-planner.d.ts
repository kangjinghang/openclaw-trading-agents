import type { ExecutionPlan, RebalancePlan } from "./rebalance-types";
/** 把 plan 的 actions 排序成可执行 sequence + cash 累计。 */
export declare function buildExecutionPlan(plan: RebalancePlan, initialCash: number): ExecutionPlan;
//# sourceMappingURL=execution-planner.d.ts.map