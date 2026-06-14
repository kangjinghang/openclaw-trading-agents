"use strict";
// src/quality-gate.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkFieldCitations = checkFieldCitations;
exports.checkNullFieldSentinels = checkNullFieldSentinels;
exports.checkDragonTigerContinuity = checkDragonTigerContinuity;
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
 * Per-role map of "critical null fields" — raw-data fields whose strict `null`
 * value signals a data-fetch failure (not a normal "no data exists" empty
 * array). When such a field is null, the analyst is required (per prompt) to
 * emit a `[数据缺失: 指标名]` sentinel declaring it missing. This table lists,
 * for each watched field, the keywords that a compliant sentinel must contain.
 *
 * Scope is deliberately narrow: only roles + fields where a confirmed false
 * negative has surfaced (e.g. 600157 hot_money). Roles whose missing-data
 * signal is usually `[]` (news/policy/market/lockup) are NOT in the table —
 * `[]` is ambiguous (could be a normal slow news day) whereas `null` is an
 * unambiguous fetch failure.
 */
const NULL_FIELD_CHECKS = {
    hot_money: [
        { field: "fund_flow", keywords: ["主力资金", "资金流", "fund_flow"] },
        { field: "sector_fund_flow", keywords: ["板块资金", "sector_fund"] },
    ],
    sentiment: [
        { field: "hot_rank", keywords: ["热度", "人气", "hot_rank"] },
        { field: "zt_pool", keywords: ["涨停池", "zt_pool"] },
    ],
    fundamentals: [
        { field: "financial_health", keywords: ["财务健康", "financial_health"] },
    ],
};
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
function checkNullFieldSentinels(content, role, rawData) {
    const checks = NULL_FIELD_CHECKS[role];
    if (!checks || !rawData || typeof rawData !== "object")
        return null;
    const data = rawData;
    // Pre-extract all sentinel payloads once (cheaper than re-scanning per field).
    const sentinelTexts = [];
    const sentinelRegex = /\[数据缺失:\s*([^\]]+)\]/g;
    let m;
    while ((m = sentinelRegex.exec(content)) !== null) {
        sentinelTexts.push(m[1]);
    }
    const missing = [];
    for (const c of checks) {
        if (data[c.field] !== null)
            continue; // only strict null = fetch failure
        const covered = sentinelTexts.some((t) => c.keywords.some((k) => t.includes(k)));
        if (!covered)
            missing.push(c.field);
    }
    if (missing.length === 0)
        return null;
    return `原始数据 ${missing.join("、")} 为 null 但报告未标注对应 [数据缺失] 哨兵`;
}
/** Chinese-numeral to integer map for the dragon_tiger continuity check. */
const CN_NUM = {
    两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
/**
 * Check 8: dragon_tiger date continuity — when a hot_money report claims
 * "连续 N 日涨停" but the underlying dragon_tiger data has fewer than N
 * entries, the claim is unsupported and likely fabricated.
 *
 * Regression: 688163 2026-06-14 hot_money report claimed "连续两日 20%涨停"
 * but dragon_tiger had only ONE entry (2026-06-12); 2026-06-13 had no data.
 * Layer-1 graded it A; Layer-2 LLM caught the fabrication. This structural
 * check closes that gap at zero LLM cost by cross-referencing the claim's
 * day count against the dragon_tiger entry count.
 *
 * Returns an issue string when an unsupported "连续 N 日" claim is detected;
 * null otherwise. Only runs for the hot_money role.
 */
function checkDragonTigerContinuity(content, role, rawData) {
    if (role !== "hot_money" || !rawData || typeof rawData !== "object")
        return null;
    const data = rawData;
    const dt = data.dragon_tiger;
    if (!Array.isArray(dt))
        return null;
    // Match "连续 N 日/天/个交易日/涨停/连板" — supports Arabic (2-19) and
    // Chinese numerals (两二三四…十). Requires the noun right after the number
    // to be a time/limit-up word so phrases like "连续两笔买入" don't false-fire.
    const regex = /连续\s*(?:([2-9]|1[0-9])|([两二三四五六七八九十]))\s*(?:个?交易日|日涨停|天涨停|日连板|涨停|连板|日大涨|天大涨|日阳线|天阳线)/g;
    const claims = [];
    let m;
    while ((m = regex.exec(content)) !== null) {
        const n = m[1] ? parseInt(m[1], 10) : CN_NUM[m[2]];
        if (n && n >= 2)
            claims.push(n);
    }
    if (claims.length === 0)
        return null;
    const maxClaim = Math.max(...claims);
    if (dt.length >= maxClaim)
        return null;
    return `报告声称"连续 ${maxClaim} 日涨停"但龙虎榜只有 ${dt.length} 条记录（数据不支持"连续"论述，疑似编造）`;
}
/**
 * Hard-check a single analyst report for quality issues.
 * Returns a QualityGrade with identified issues.
 *
 * `rawData` (optional) is the parsed JSON the analyst was given; when present,
 * Check 7 cross-references null fields against sentinel coverage.
 */
function hardCheckReport(report, rawData) {
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
    // Check 7: Null-field sentinel coverage — when raw data has a null field
    // (fetch failure), the analyst must declare it via `[数据缺失: ...]`.
    // Catches the loophole where analysts paraphrase "数据缺失" in prose
    // instead of using the bracketed form, bypassing Check 4b's counter.
    if (rawData !== undefined) {
        const nullIssue = checkNullFieldSentinels(content, report.role, rawData);
        if (nullIssue)
            issues.push(nullIssue);
    }
    // Check 8: dragon_tiger continuity — when a hot_money report claims
    // "连续 N 日涨停" but dragon_tiger has < N entries, the claim is
    // unsupported (688163 regression: "连续两日" with only 1 dragon_tiger
    // entry; 2026-06-13 had no data). Zero-LLM-cost fabrication detector
    // complementary to Layer-2's semantic review.
    if (rawData !== undefined) {
        const continuityIssue = checkDragonTigerContinuity(content, report.role, rawData);
        if (continuityIssue)
            issues.push(continuityIssue);
    }
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
 * `dataResults` (optional) is the orchestrator's per-role raw-data bundle.
 * When supplied, Check 7 cross-references null fields against sentinel
 * coverage; when omitted, the function falls back to legacy text-only checks.
 *
 * The summary_text is designed to be injected into downstream prompts
 * (debate, research manager, trader) so they know which data to trust.
 */
function validateAnalystReports(reports, dataResults) {
    const rawByRole = new Map();
    if (dataResults) {
        for (const { role, result } of dataResults) {
            if (result.success && result.data)
                rawByRole.set(role, result.data);
        }
    }
    const grades = reports.map((r) => hardCheckReport(r, rawByRole.get(r.role)));
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