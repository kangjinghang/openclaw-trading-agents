import type { CandidateEntry, CandidatesFile, DistributionStats, ExcludedEntry, RankedEntry, ScanGroupBreakdown, ScanGroupResult, ScanSummary } from "./types";
/** 共同过滤：ST/退 + 科创板 SH688（用户无交易权限）。
 *  正则避免误伤名字含 ST 字样的正常股（如 BEST...）。 */
export declare function filterCommon(c: CandidateEntry): boolean;
/** SHORT 专有过滤：continued 一律留；new 必须今日有异动。
 *  diff.ts 要求 ongoing range.end === todayStartMs 才入选，故今日事件 =
 *  range_events 中 timestamp === range.end 的子集。
 *
 *  防御性：老 candidates.json（range_events 字段引入前）没有该字段，
 *  视为空事件链 → 等价于"new + 无今日异动"被丢弃。 */
export declare function filterShortExtra(c: CandidateEntry): boolean;
/** LONG 单股格式 B：5 段（含区间事件链，让 LLM 看趋势演化） */
export declare function formatLongEntry(c: CandidateEntry, idx: number): string;
/** SHORT 单股格式 B：4 段 + 今日（SHORT 区间短，事件链多为空，不加） */
export declare function formatShortEntry(c: CandidateEntry, idx: number): string;
interface RankResponse {
    ranked: Array<{
        ticker: string;
        name: string;
        score: number;
        reason: string;
    }>;
    excluded: Array<{
        ticker: string;
        name: string;
        reason: string;
    }>;
}
/** 解析 LLM 排名输出：校验结构 + 过滤幻觉 ticker。失败返回 null。 */
export declare function parseRankResponse(content: string, validTickers: Set<string>): RankResponse | null;
/** 规则降级：LONG 按 days/percent 排，SHORT 按 percent/days 排。
 *  分数 6.0 起步 -0.2 递减，最低 4.0（明显低于 LLM 区，一眼可识别）。 */
export declare function fallbackRank(pool: CandidateEntry[], topN: number, group: "LONG" | "SHORT"): {
    ranked: RankedEntry[];
    excluded: ExcludedEntry[];
};
/** 算一组数字的分位（min/p25/median/p75/max），用线性插值。
 *  空数组返回 null。导出便于测试。 */
export declare function computeDistribution(values: number[]): DistributionStats | null;
/** 单股的今日催化强度分类。
 *  - limit_up: 今日涨停（description 含"涨停"，或涨幅 ≥ 板涨停阈值：
 *    创业板 SZ300/SZ301 / 科创板 SH688 阈值 19.5%；其他 9.5%）
 *  - pct_over_5: 今日涨幅 >5%（但未达涨停）
 *  - pct_under_5: 今日有事件但提取不出 >5% 涨幅
 *  - none: 今日无事件（range_events 中无 timestamp === range.end 的事件）
 *
 *  导出便于测试。 */
export declare function classifyTodayCatalyst(c: CandidateEntry): "limit_up" | "pct_over_5" | "pct_under_5" | "none";
/** 算 pool 的 range_kind + today_catalyst 计数。pool 为空返回 null。 */
export declare function computeBreakdown(pool: CandidateEntry[]): ScanGroupBreakdown | null;
/**
 * LLM 返回的 ticker/name/score/reason + 候选股反查 → 补 percent/days/range_kind。
 *
 * LLM 偶尔会把另一只股票的理由串到真实 ticker 上（如把"大元泵业"的液冷泵理由挂到
 * SH603259 药明康德）。parseRankResponse 只校验 ticker 真实性，无法发现这类串号；
 * 候选池的 name 来自雪球原始数据，是权威来源。防护：
 *   1. name 用候选池覆盖（阻断串号向下游传播）
 *   2. reason 名称校验：若 reason 提到了候选池中其他公司的名称，判定为串号并丢弃
 */
export declare function enrichRanked(llmRanked: Array<{
    ticker: string;
    name: string;
    score: number;
    reason: string;
}>, lookup: Map<string, CandidateEntry>): RankedEntry[];
/** LLM 调用抽象。CLI 包装 callLLM；测试 mock。返回原始 content。 */
export type RankLlmCaller = (input: {
    group: "LONG" | "SHORT";
    systemPrompt: string;
    userMessage: string;
}) => Promise<string>;
export interface RankOptions {
    topLong: number;
    topShort: number;
    caller: RankLlmCaller;
}
export interface RankResult {
    longResult: ScanGroupResult;
    shortResult: ScanGroupResult;
    summary: ScanSummary;
}
/** 主入口：拆分 → 共同过滤 → SHORT 专有过滤 → LLM/降级 → 补齐 → 合并。 */
export declare function rankCandidates(candidates: CandidatesFile, options: RankOptions): Promise<RankResult>;
/** 合并 scan.json。top_picks 跨组按 score 降序。 */
export declare function mergeScan(longResult: ScanGroupResult, shortResult: ScanGroupResult, totalCandidates: number, scanDate: string): ScanSummary;
export {};
//# sourceMappingURL=ranker.d.ts.map