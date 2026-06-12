"use strict";
// src/quality-gate.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkFieldCitations = checkFieldCitations;
exports.validateAnalystReports = validateAnalystReports;
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
 * High-signal data-field keywords each analyst role is expected to cite.
 * A report that genuinely engaged with its data will hit at least one keyword
 * (or cite several numeric values). Zero keyword hits AND fewer than three
 * numeric citations is a strong "ignored the data, wrote generic prose" signal.
 *
 * Conservative by design: keyword lists are generous, and a numeric-citation
 * floor gives a second chance so synonym-using but data-grounded reports are
 * not false-positive'd. Complements the LLM Layer-2 review (which catches
 * semantic issues like fabrication); this catches the cruder "wrote nothing
 * real" case at zero cost.
 */
const ROLE_CITATIONS = {
    market: ["收盘", "涨跌", "成交量", "成交额", "均线", "SMA", "MACD", "RSI", "KDJ", "布林", "换手", "量价", "量比", "支撑", "阻力", "VPA", "金叉", "死叉"],
    fundamentals: ["PE", "市盈率", "PB", "市净率", "ROE", "净利润", "净利", "营收", "收入", "商誉", "现金流", "资产负债", "负债率", "毛利率", "净利率", "EPS", "PEG", "forward", "ROA"],
    news: ["新闻", "公告", "利好", "利空", "政策", "事件", "披露", "调研", "预告", "快报", "合同", "中标", "收购", "重组"],
    sentiment: ["情绪", "涨停", "连板", "炸板", "热度", "看多", "看空", "悲观", "乐观", "龙头", "追涨", "恐慌", "氛围"],
    policy: ["政策", "国务院", "证监会", "监管", "扶持", "补贴", "利好", "利空", "产业", "部委", "通知", "意见", "央行", "发改委"],
    hot_money: ["北向", "主力", "龙虎榜", "资金", "游资", "净流入", "净流出", "板块", "换手", "大单", "超大单", "吸筹", "出货"],
    lockup: ["解禁", "减持", "股东", "限售", "质押", "压力", "增持", "解禁市值", "流通"],
};
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
function checkFieldCitations(content, role) {
    const keywords = ROLE_CITATIONS[role];
    if (!keywords)
        return null;
    const cleaned = content.replace(/\[数据缺失:\s*[^\]]*\]/g, "");
    if (keywords.some((k) => cleaned.includes(k)))
        return null;
    const numbers = cleaned.match(/\d+(\.\d+)?/g) || [];
    if (numbers.length >= 3)
        return null;
    return "未引用关键数据字段且缺少数值引用（疑似无视数据写水文）";
}
/**
 * Hard-check a single analyst report for quality issues.
 * Returns a QualityGrade with identified issues.
 */
function hardCheckReport(report) {
    const issues = [];
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
    const foundMarkers = [];
    for (const marker of FAILURE_MARKERS) {
        if (content.includes(marker)) {
            foundMarkers.push(marker);
        }
    }
    if (foundMarkers.length >= 3) {
        issues.push(`包含多个失败标记: ${foundMarkers.slice(0, 3).join(", ")}`);
    }
    // Check 4b: [数据缺失: 指标名] sentinels — the structured form analysts emit
    // when a required field is genuinely unavailable. Check 4 counts DISTINCT
    // marker phrases (catches reports vomiting "无法获取"+"分析失败"+"暂无数据"
    // together); this check counts OCCURRENCES of the single sentinel shape, so
    // a report with 13 missing-field sentinels doesn't score as "1 distinct
    // marker". ≥3 means the analyst couldn't access most required data, so the
    // conclusion's credibility is materially impaired. Regression: 600600 news
    // had 13 sentinels and got grade A because Check 4 alone missed it.
    const sentinelMatches = content.match(/\[数据缺失:\s*[^\]]+\]/g) || [];
    if (sentinelMatches.length >= 3) {
        issues.push(`包含 ${sentinelMatches.length} 个 [数据缺失] 哨兵（多项必采项无数据）`);
    }
    // Check 5: Verdict missing
    if (report.verdict.direction === "中性" && report.verdict.reason === "无法解析结论") {
        issues.push("VERDICT 解析失败");
    }
    // Check 6: Field citation — did the report engage with its data at all?
    const citationIssue = checkFieldCitations(content, report.role);
    if (citationIssue)
        issues.push(citationIssue);
    // Determine grade based on issue count
    const grade = issues.length === 0 ? "A" :
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
function validateAnalystReports(reports) {
    const grades = reports.map(hardCheckReport);
    const failedRoles = grades.filter((g) => g.grade === "F").map((g) => g.role);
    const warnRoles = grades.filter((g) => g.grade === "D").map((g) => g.role);
    // Build human-readable summary for prompt injection
    const lines = ["## 数据质量门控报告\n"];
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
//# sourceMappingURL=quality-gate.js.map