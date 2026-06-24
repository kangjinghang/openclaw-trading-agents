"use strict";
// src/watchlist/bench-stats.ts
//
// bench 统计计算器：纯函数，数组进、数字/对象出。无 IO、无 LLM、无 fs。
// 被 bench-runner.ts 调用聚合 results → stats。
Object.defineProperty(exports, "__esModule", { value: true });
exports.percentile = percentile;
exports.coefficientOfVariation = coefficientOfVariation;
exports.modeConsistency = modeConsistency;
exports.topKConsistency = topKConsistency;
exports.meanAbsScoreDiff = meanAbsScoreDiff;
exports.summarizeConfigStats = summarizeConfigStats;
/**
 * 数组的分位数（0-1）。p90 用 ceil 索引：idx = ceil(p*n) - 1。
 * 空数组或 p 越界返回 null。
 */
function percentile(values, p) {
    if (values.length === 0)
        return null;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
}
/**
 * 变异系数 CV = std / |mean|。均值=0 或空数组返回 null。
 */
function coefficientOfVariation(values) {
    if (values.length === 0)
        return null;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    if (mean === 0)
        return null;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance) / Math.abs(mean);
}
/**
 * 众数一致率：离散值数组里出现最多的值占比。空数组返回 null。
 * 用于 risk-shallow 的 overall_risk（high/medium/low）稳定性。
 */
function modeConsistency(values) {
    if (values.length === 0)
        return null;
    const counts = {};
    for (const v of values)
        counts[v] = (counts[v] || 0) + 1;
    const max = Math.max(...Object.values(counts));
    return max / values.length;
}
/**
 * top-K 一致率：所有列表两两组合，top-K 重叠率（交集数 / K）的平均。
 * K 大于列表长度时，分母取 min(K, 较短列表长度)。
 * 少于 2 个列表返回 null。用于 rank phase。
 */
function topKConsistency(lists, k) {
    if (lists.length < 2)
        return null;
    let total = 0;
    let pairs = 0;
    for (let i = 0; i < lists.length; i++) {
        for (let j = i + 1; j < lists.length; j++) {
            const a = new Set(lists[i]);
            const b = new Set(lists[j]);
            let overlap = 0;
            for (const x of a)
                if (b.has(x))
                    overlap++;
            const denom = Math.min(k, Math.min(lists[i].length, lists[j].length));
            total += denom > 0 ? overlap / denom : 0;
            pairs++;
        }
    }
    return pairs > 0 ? total / pairs : null;
}
/**
 * 与 baseline 的分数差均值：对 baseline 每个 ticker，取 run 里同 ticker 的分数，
 * 算绝对差，求均值。无重叠返回 null。用于 rank phase。
 */
function meanAbsScoreDiff(baseline, run) {
    const runMap = new Map(run.map(r => [r.ticker, r.score]));
    let sum = 0;
    let count = 0;
    for (const b of baseline) {
        if (runMap.has(b.ticker)) {
            sum += Math.abs(b.score - runMap.get(b.ticker));
            count++;
        }
    }
    return count > 0 ? sum / count : null;
}
/**
 * 按 config 聚合单次调用结果 → ConfigStats。
 * 耗时/tokens 只统计 ok:true 的调用；成功率分母是 expected_calls。
 */
function summarizeConfigStats(configId, calls, expectedCalls) {
    const okCalls = calls.filter(c => c.ok);
    const parsedOk = okCalls.filter(c => c.parsed._parse_ok);
    return {
        config_id: configId,
        success_count: okCalls.length,
        expected_calls: expectedCalls,
        success_rate: expectedCalls > 0 ? okCalls.length / expectedCalls : 0,
        duration_median_ms: percentile(okCalls.map(c => c.duration_ms), 0.5),
        duration_p90_ms: percentile(okCalls.map(c => c.duration_ms), 0.9),
        prompt_tokens_median: percentile(okCalls.map(c => c.usage.prompt_tokens), 0.5),
        completion_tokens_median: percentile(okCalls.map(c => c.usage.completion_tokens), 0.5),
        parse_success_rate: okCalls.length > 0 ? parsedOk.length / okCalls.length : 0,
        total_cost_usd: okCalls.reduce((s, c) => s + c.cost_usd, 0),
    };
}
//# sourceMappingURL=bench-stats.js.map