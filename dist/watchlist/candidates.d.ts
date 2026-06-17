import type { DiffFile, CandidatesFile } from "./types";
/**
 * Build the candidate list from a diff.
 *
 * 只收有 range 的股(B1 或 B2),丢弃只有 A 类今日涨 reason 的股(信号弱)。
 * 每个候选保留雪球完整字段(range 的 8 字段 + today_reasons 的 4 字段)。
 */
export declare function buildCandidates(diff: DiffFile): CandidatesFile;
//# sourceMappingURL=candidates.d.ts.map