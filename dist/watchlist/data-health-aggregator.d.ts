import type { SourceCall } from "../types";
export interface SourceStat {
    stage: string;
    success: number;
    failure: number;
    total: number;
    success_rate: number;
    avg_duration_ms: number;
    last_error?: string;
}
export interface RollingStat {
    stage: string;
    success: number;
    failure: number;
    total: number;
    success_rate: number;
    avg_duration_ms: number;
    last_error?: string;
    last_success_at?: string;
    last_failure_at?: string;
    runs_with_data: number;
}
export interface DataHealthReport {
    run_date: string;
    /** 本次 run 各子源的调用统计 */
    current_run: SourceStat[];
    /** 7 天滚动统计（含本次） */
    rolling_7d: RollingStat[];
    /** 30 天滚动统计（含本次） */
    rolling_30d: RollingStat[];
}
/** 把一个 run 的所有 SourceCall[] 聚合为 per-stage 统计。 */
export declare function aggregateRun(calls: SourceCall[]): SourceStat[];
interface StoredRun {
    run_date: string;
    calls: Array<{
        stage: string;
        success: boolean;
        error?: string | null;
        duration_ms?: number | null;
    }>;
}
/** 计算指定天数窗口内的滚动统计。 */
export declare function computeRollingStats(runs: StoredRun[], windowDays: number, currentDate: string): RollingStat[];
/** 生成完整的 DataHealthReport。 */
export declare function generateDataHealthReport(runDate: string, currentCalls: SourceCall[], rebalanceDir: string): DataHealthReport;
export {};
//# sourceMappingURL=data-health-aggregator.d.ts.map