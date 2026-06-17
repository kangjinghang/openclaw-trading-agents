"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeDiff = computeDiff;
/** 取 range 列表中 end 最大的(即"最新一个"区间);空数组返回 null。
 * 雪球的 range.end 总是某天 00:00:00 北京时间,end 越大 = 越近。 */
function latestRange(ranges) {
    if (!ranges || ranges.length === 0)
        return null;
    return ranges.reduce((a, b) => (b.end > a.end ? b : a));
}
/**
 * Compute diff between today's snapshot and a baseline snapshot.
 *
 * 简化逻辑(对齐"今日股票池"心智):每只股只看 reason_list / range_reason_list **最新一条**。
 *
 * 三类入选条件,A 和 B 独立判断,各自都要满足"今日 + 上涨":
 *   - A 类 (today_reason_points): 最新 reason.timestamp == 今天
 *                                   + description 含"涨"(剔除今日下跌/中性事件)
 *   - B1 延续型 (continued_ranges): 最新 range.end == 今天
 *                                   + begin 与 baseline 最新相同(baseline 最新 end != 今天 — 排除"完全不变")
 *                                   + percent > 0(剔除下跌区间)
 *   - B2 新成型 (new_ranges):       最新 range.end == 今天 + begin 不同 / baseline 无
 *                                   + percent > 0
 *
 * 雪球的 timestamp / range.end 都是"某天 00:00:00 北京时间"的精度,
 * 用 `=== todayStartMs` 精确比较即可。
 */
function computeDiff(today, baseline) {
    const changes = [];
    // 今天 00:00:00 北京时间的毫秒时间戳(雪球 range.end 的精度)
    const todayStartMs = Date.parse(today.end_date + "T00:00:00+08:00");
    for (const [ticker, todayEntry] of Object.entries(today.stocks)) {
        if (todayEntry.scan_error)
            continue;
        const baselineEntry = baseline?.stocks?.[ticker];
        // A 类:最新 reason 是今天 + description 含"涨"(只认今日上涨事件)
        // description 由雪球生成,通常格式"...收盘价X元，涨幅Y%"/"...涨停..."
        const todayReasons = (todayEntry.reason_list ?? []).filter((r) => r.timestamp === todayStartMs && !!r.description && r.description.includes("涨"));
        // range 比较:只看最新一个(end 最大的)
        const todayLatest = latestRange(todayEntry.range_reason_list);
        const baselineLatest = latestRange(baselineEntry?.range_reason_list);
        const continuedRanges = [];
        const newRanges = [];
        // B 类:最新 range end 是今天 + 上涨(percent > 0)
        if (todayLatest && todayLatest.end === todayStartMs && todayLatest.percent > 0) {
            const sameBegin = baselineLatest && baselineLatest.begin === todayLatest.begin;
            const baselineEndIsAlsoToday = baselineLatest && baselineLatest.end === todayStartMs;
            if (sameBegin && !baselineEndIsAlsoToday) {
                // B1 延续型:begin 相同,baseline 的 end 还没到今天 → today 把 end 推到了今天
                continuedRanges.push(todayLatest);
            }
            else if (!sameBegin) {
                // B2 新成型:begin 不同(或 baseline 没有)
                newRanges.push(todayLatest);
            }
            // else: sameBegin && baselineEndIsAlsoToday → 完全不变 → 不选
        }
        if (todayReasons.length > 0 || continuedRanges.length > 0 || newRanges.length > 0) {
            changes.push({
                ticker,
                name: todayEntry.name,
                today_reason_points: todayReasons,
                continued_ranges: continuedRanges,
                new_ranges: newRanges,
            });
        }
    }
    return {
        scan_date: today.scan_date,
        baseline: baseline?.scan_date ?? "",
        changes,
    };
}
//# sourceMappingURL=diff.js.map