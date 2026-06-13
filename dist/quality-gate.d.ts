import { AnalystReport, QualitySummary, ScriptResult } from "./types";
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
 * Cross-check raw data null fields against `[数据缺失: ...]` sentinel coverage.
 * Returns an issue string listing every null field that lacks a matching
 * sentinel; null when all null fields are properly declared (or no watched
 * fields are null).
 *
 * Regression: 600157 hot_money had fund_flow=null + sector_fund_flow=null
 * (push2 rate-limited). The analyst wrote plain-text "数据缺失" instead of
 * the bracketed sentinel form, so Layer-1's sentinel counter saw zero
 * matches and graded it A. This check closes that loophole by consulting
 * the raw data the analyst was given.
 */
export declare function checkNullFieldSentinels(content: string, role: string, rawData: unknown): string | null;
/**
 * Validate all analyst reports and produce a quality summary.
 *
 * `dataResults` (optional) is the orchestrator's per-role raw-data bundle.
 * When supplied, Check 7 cross-references null fields against sentinel
 * coverage; when omitted, the function falls back to legacy text-only checks.
 *
 * The summary_text is designed to be injected into downstream prompts
 * (debate, research manager, trader) so they know which data to trust.
 */
export declare function validateAnalystReports(reports: AnalystReport[], dataResults?: Array<{
    role: string;
    result: ScriptResult;
}>): QualitySummary;
//# sourceMappingURL=quality-gate.d.ts.map