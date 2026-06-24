import type { ExecStatus, Execution } from "./rebalance-types";
/** 终态：filled/partial/failed。终态订单不可被 pending 覆盖。 */
export declare function isTerminal(status: ExecStatus): boolean;
/** 待执行：仅 pending。 */
export declare function isPending(status: ExecStatus): boolean;
/** 开发机产出订单时的标准 pending 占位。每次返回新对象避免共享引用。 */
export declare function makePendingExecution(): Execution;
//# sourceMappingURL=execution-schema.d.ts.map