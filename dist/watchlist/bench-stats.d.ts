import type { BenchCallResult, ConfigStats } from "./bench-types";
/**
 * 数组的分位数（0-1）。p90 用 ceil 索引：idx = ceil(p*n) - 1。
 * 空数组或 p 越界返回 null。
 */
export declare function percentile(values: number[], p: number): number | null;
/**
 * 变异系数 CV = std / |mean|。均值=0 或空数组返回 null。
 */
export declare function coefficientOfVariation(values: number[]): number | null;
/**
 * 众数一致率：离散值数组里出现最多的值占比。空数组返回 null。
 * 用于 risk-shallow 的 overall_risk（high/medium/low）稳定性。
 */
export declare function modeConsistency(values: string[]): number | null;
/**
 * top-K 一致率：所有列表两两组合，top-K 重叠率（交集数 / K）的平均。
 * K 大于列表长度时，分母取 min(K, 较短列表长度)。
 * 少于 2 个列表返回 null。用于 rank phase。
 */
export declare function topKConsistency(lists: string[][], k: number): number | null;
/**
 * 与 baseline 的分数差均值：对 baseline 每个 ticker，取 run 里同 ticker 的分数，
 * 算绝对差，求均值。无重叠返回 null。用于 rank phase。
 */
export declare function meanAbsScoreDiff(baseline: Array<{
    ticker: string;
    score: number;
}>, run: Array<{
    ticker: string;
    score: number;
}>): number | null;
/**
 * 按 config 聚合单次调用结果 → ConfigStats。
 * 耗时/tokens 只统计 ok:true 的调用；成功率分母是 expected_calls。
 */
export declare function summarizeConfigStats(configId: string, calls: BenchCallResult[], expectedCalls: number): ConfigStats;
//# sourceMappingURL=bench-stats.d.ts.map