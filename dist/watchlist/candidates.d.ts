import type { DiffFile, RawSnapshotFile, CandidatesFile } from "./types";
/**
 * Build the candidate list from a diff and today's raw snapshot.
 *
 * 按代表趋势的 percent 正负拆成三组：
 *   up   —— 上涨候选（percent > 0），找做多机会
 *   down —— 下跌候选（percent < 0），找卖点/规避
 *   neutral —— 无区间趋势（仅有 reason_list 异动点）
 *
 * 每组内按"进行中 > 持续长 > 幅度大"排序。
 *
 * @param diff 第2层 diff 结果
 * @param rawToday 今日 raw 快照（top_trend 取自此处的完整 range 列表）
 */
export declare function buildCandidates(diff: DiffFile, rawToday: RawSnapshotFile): CandidatesFile;
//# sourceMappingURL=candidates.d.ts.map