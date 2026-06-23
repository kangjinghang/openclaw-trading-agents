import type { FitnessHistoryStore } from "./fitness-history-store";
/** 结算结果（供 rebalance-cli 打日志）。 */
export interface BackfillResult {
    settled: number;
    skipped: number;
    failed: number;
}
/**
 * 懒结算所有到期 open 记录。在 rebalance-cli 主流程开头调用。
 *
 * 判定到期：距 decision_date ≥30 天（这样 7/14/30 三窗口都过了，一次结算全算）。
 * 不到 30 天的跳过（下次再算）。
 *
 * 返回统计。永不抛——调用方仍应包 try/catch 做双保险。
 */
export declare function backfillReturns(store: FitnessHistoryStore, currentDate: string): Promise<BackfillResult>;
//# sourceMappingURL=fitness-backfiller.d.ts.map