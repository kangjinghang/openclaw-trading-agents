"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCandidates = buildCandidates;
/** 区间跨度天数 */
function rangeDays(r) {
    return Math.round((r.end - r.begin) / (24 * 60 * 60 * 1000));
}
/**
 * 从 diff 的 change 构造候选条目。
 *
 * - range 取自 continued_ranges[0] 或 new_ranges[0](computeDiff 保证每只股最多 1 个 range)
 * - range_kind 标 continued(B1) 或 new(B2)
 * - today_reasons 直接搬 change.today_reason_points(完整雪球字段)
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
        today_reasons: change.today_reason_points,
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
 * 每个候选保留雪球完整字段(range 的 8 字段 + today_reasons 的 4 字段)。
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
//# sourceMappingURL=candidates.js.map