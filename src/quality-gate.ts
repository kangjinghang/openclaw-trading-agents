// src/quality-gate.ts

import { AnalystReport, QualityGrade, QualitySummary } from "./types";

/** Failure markers that indicate the LLM could not produce a real report. */
const FAILURE_MARKERS = [
  "无法获取",
  "无法获取数据",
  "I cannot retrieve",
  "I cannot access",
  "data is not available",
  "数据缺失",
  "未能获取",
  "分析失败",
  "暂无数据",
  "No data available",
  "insufficient data",
  "无法完成分析",
];

/** Minimum report length to be considered usable. */
const MIN_REPORT_LENGTH = 200;

/**
 * Hard-check a single analyst report for quality issues.
 * Returns a QualityGrade with identified issues.
 */
function hardCheckReport(report: AnalystReport): QualityGrade {
  const issues: string[] = [];
  const content = report.content;

  // Check 1: Empty or error placeholder
  if (!content || content.trim().length === 0) {
    return { role: report.role, grade: "F", issues: ["报告为空"] };
  }

  // Check 2: Starts with error marker
  if (content.startsWith("[分析失败") || content.startsWith("[数据缺失")) {
    return { role: report.role, grade: "F", issues: ["报告以错误标记开头"] };
  }

  // Check 3: Minimum length
  if (content.length < MIN_REPORT_LENGTH) {
    issues.push(`报告过短 (${content.length} 字符，最低 ${MIN_REPORT_LENGTH})`);
  }

  // Check 4: Failure markers
  const foundMarkers: string[] = [];
  for (const marker of FAILURE_MARKERS) {
    if (content.includes(marker)) {
      foundMarkers.push(marker);
    }
  }
  if (foundMarkers.length >= 3) {
    issues.push(`包含多个失败标记: ${foundMarkers.slice(0, 3).join(", ")}`);
  }

  // Check 5: Verdict missing
  if (report.verdict.direction === "中性" && report.verdict.reason === "无法解析结论") {
    issues.push("VERDICT 解析失败");
  }

  // Determine grade based on issue count
  const grade: QualityGrade["grade"] =
    issues.length === 0 ? "A" :
    issues.length === 1 ? "B" :
    issues.length === 2 ? "C" :
    issues.length === 3 ? "D" : "F";

  return { role: report.role, grade, issues };
}

/**
 * Validate all analyst reports and produce a quality summary.
 *
 * The summary_text is designed to be injected into downstream prompts
 * (debate, research manager, trader) so they know which data to trust.
 */
export function validateAnalystReports(reports: AnalystReport[]): QualitySummary {
  const grades = reports.map(hardCheckReport);

  const failedRoles = grades.filter((g) => g.grade === "F").map((g) => g.role);
  const warnRoles = grades.filter((g) => g.grade === "D").map((g) => g.role);

  // Build human-readable summary for prompt injection
  const lines: string[] = ["## 数据质量门控报告\n"];
  lines.push("| 分析师 | 等级 | 问题 |");
  lines.push("|--------|------|------|");
  for (const g of grades) {
    const issueText = g.issues.length > 0 ? g.issues.join("；") : "—";
    lines.push(`| ${g.role} | ${g.grade} | ${issueText} |`);
  }

  if (failedRoles.length > 0) {
    lines.push(`\n**严重警告**：以下分析师报告不可用，其结论应被忽略：${failedRoles.join("、")}`);
  }
  if (warnRoles.length > 0) {
    lines.push(`\n**注意**：以下分析师报告质量较差，使用时需谨慎：${warnRoles.join("、")}`);
  }

  return {
    grades,
    failed_count: failedRoles.length,
    warn_count: warnRoles.length,
    summary_text: lines.join("\n"),
  };
}
