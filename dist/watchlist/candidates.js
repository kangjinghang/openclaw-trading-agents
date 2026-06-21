"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCandidates = buildCandidates;
exports.buildDailyCandidates = buildDailyCandidates;
/** 区间跨度天数 */
function rangeDays(r) {
    return Math.round((r.end - r.begin) / (24 * 60 * 60 * 1000));
}
/**
 * 从 diff 的 change 构造候选条目。
 *
 * - range 取自 continued_ranges[0] 或 new_ranges[0](computeDiff 保证每只股最多 1 个 range)
 * - range_kind 标 continued(B1) 或 new(B2)
 * - range_events 直接搬 change.range_events(diff 已过滤到 [range.begin, range.end] 区间)
 *
 * 如果 change 没 range(A only)→ 返回 null,不进候选。
 */
function buildEntry(change) {
    let range;
    let kind;
    if (change.continued_ranges.length > 0) {
        range = change.continued_ranges[0];
        kind = "continued";
    }
    else if (change.new_ranges.length > 0) {
        range = change.new_ranges[0];
        kind = "new";
    }
    else {
        return null; // 只有 A 类,无 range,不进候选
    }
    return {
        ticker: change.ticker,
        name: change.name,
        range,
        range_kind: kind,
        days: rangeDays(range),
        range_events: change.range_events,
    };
}
/**
 * 组内排序:days 大 > |percent| 大
 * (所有 range 都是 diff 给的 end=今天 + 上涨,ongoing 同质,不再用 ongoing 排序)
 */
function sortGroup(group) {
    return [...group].sort((a, b) => b.days - a.days || Math.abs(b.range.percent) - Math.abs(a.range.percent));
}
/**
 * Build the candidate list from a diff.
 *
 * 只收有 range 的股(B1 或 B2),丢弃只有 A 类今日涨 reason 的股(信号弱)。
 * 每个候选保留雪球完整字段(range 的 8 字段 + range_events 的 4 字段)。
 */
function buildCandidates(diff) {
    const up = [];
    for (const change of diff.changes) {
        const entry = buildEntry(change);
        if (entry)
            up.push(entry);
    }
    return {
        scan_date: diff.scan_date,
        up: sortGroup(up),
    };
}
/** 从 reason description 提取涨幅%：「涨幅X%」取 X；含「涨停」算 10；其余 null。 */
function extractPct(description) {
    const m = description.match(/涨幅([0-9]+(?:\.[0-9]+)?)%/);
    if (m)
        return parseFloat(m[1]);
    if (description.includes("涨停"))
        return 10;
    return null;
}
/**
 * Build the daily-movement candidate list from a diff.
 *
 * 单日异动榜：只收 today_reason_points 非空的股（今日上涨事件），不看区间。
 * pct 取该股今日所有 reason 中提取出的最大涨幅；提取不出为 null。
 * 按 pct 降序（null 排后）。today_reasons 完整保留。
 */
function buildDailyCandidates(diff) {
    const up = [];
    for (const change of diff.changes) {
        if (change.today_reason_points.length === 0)
            continue;
        const pcts = change.today_reason_points
            .map((r) => extractPct(r.description ?? ""))
            .filter((p) => p !== null);
        const pct = pcts.length > 0 ? Math.max(...pcts) : null;
        up.push({
            ticker: change.ticker,
            name: change.name,
            pct,
            today_reasons: change.today_reason_points,
        });
    }
    up.sort((a, b) => {
        if (a.pct === null && b.pct === null)
            return 0;
        if (a.pct === null)
            return 1;
        if (b.pct === null)
            return -1;
        return b.pct - a.pct;
    });
    return { scan_date: diff.scan_date, up };
}
//# sourceMappingURL=candidates.js.map