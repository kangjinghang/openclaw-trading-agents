import type { DiffFile, CandidatesFile, DailyCandidatesFile } from "./types";
/**
 * Build the candidate list from a diff.
 *
 * 只收有 range 的股(B1 或 B2),丢弃只有 A 类今日涨 reason 的股(信号弱)。
 * 每个候选保留雪球完整字段(range 的 8 字段 + today_reasons 的 4 字段)。
 */
export declare function buildCandidates(diff: DiffFile): CandidatesFile;
/**
 * Build the daily-movement candidate list from a diff.
 *
 * 单日异动榜：只收 today_reason_points 非空的股（今日上涨事件），不看区间。
 * pct 取该股今日所有 reason 中提取出的最大涨幅；提取不出为 null。
 * 按 pct 降序（null 排后）。today_reasons 完整保留。
 */
export declare function buildDailyCandidates(diff: DiffFile): DailyCandidatesFile;
//# sourceMappingURL=candidates.d.ts.map