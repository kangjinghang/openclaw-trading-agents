import type { LastRebalanceAction } from "./rebalance-types";
/** 规范化 actions 到稳定字符串：按 ticker 排序，weight 四舍五入到 4 位。 */
export declare function canonicalizeActions(actions: LastRebalanceAction[]): string;
/** 计算幂等 order_id："YYYY-MM-DD-<6位hex>"。 */
export declare function computeOrderId(date: string, actions: LastRebalanceAction[]): string;
//# sourceMappingURL=order-id.d.ts.map