import { AnalystReport, QualitySummary } from "./types";
/**
 * Check whether a report engaged with its data at all. Returns an issue string
 * when the report cites none of its role's key fields AND lacks numeric
 * citations; null otherwise. Unknown roles are skipped (no check).
 *
 * `[数据缺失: 指标名]` sentinels are stripped before the keyword/numeric scan
 * so a field declared missing doesn't itself satisfy the citation check —
 * otherwise a report saying "[数据缺失: 新闻]" would be treated as if it had
 * cited news data.
 */
export declare function checkFieldCitations(content: string, role: string): string | null;
/**
 * Validate all analyst reports and produce a quality summary.
 *
 * The summary_text is designed to be injected into downstream prompts
 * (debate, research manager, trader) so they know which data to trust.
 */
export declare function validateAnalystReports(reports: AnalystReport[]): QualitySummary;
//# sourceMappingURL=quality-gate.d.ts.map