"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCandidates = buildCandidates;
/** 区间是否"进行中"：end 在扫描日当天或之后（雪球可能返回 end=今天） */
function isOngoing(range, scanDateMs) {
    return range.end >= scanDateMs;
}
/** 区间跨度天数 */
function rangeDays(range) {
    return Math.round((range.end - range.begin) / (24 * 60 * 60 * 1000));
}
/**
 * 从该股今日的 range_reason_list 选出"代表趋势"（最强一条）。
 *
 * 优先级（已修正 LONG/SHORT 语义误解 —— type 是窗口长度非方向）：
 *   1. 进行中（end 靠近扫描日）> 已结束
 *   2. 持续天数长 > 短（长周期趋势更可靠）
 *   3. |percent| 大 > 小（波动幅度大）
 *
 * 注意：此处只选"该股的代表趋势"，不区分涨跌方向。涨跌方向的分组在
 * buildCandidates 里按 percent 正负做。这样一只股的 top_trend 可能是
 * 上涨也可能下跌，取决于它最强的那条区间。
 */
function pickTopTrend(ranges, scanDateMs) {
    if (!ranges || ranges.length === 0)
        return null;
    const scored = ranges.map((r) => ({
        r,
        ongoing: isOngoing(r, scanDateMs) ? 1 : 0,
        days: rangeDays(r),
        absPct: Math.abs(r.percent),
    }));
    scored.sort((a, b) => b.ongoing - a.ongoing ||
        b.days - a.days ||
        b.absPct - a.absPct);
    const top = scored[0].r;
    return {
        type: top.type,
        percent: top.percent,
        days: rangeDays(top),
        ongoing: isOngoing(top, scanDateMs),
    };
}
/**
 * 组内排序：进行中优先，其次持续天数长，其次 |percent| 大。
 */
function sortGroup(group) {
    return [...group].sort((a, b) => {
        const ta = a.top_trend, tb = b.top_trend;
        if (!ta && !tb)
            return 0;
        if (!ta)
            return 1; // 无趋势排最后（理论上 neutral 已分离，防御）
        if (!tb)
            return -1;
        return ((tb.ongoing ? 1 : 0) - (ta.ongoing ? 1 : 0) ||
            tb.days - ta.days ||
            Math.abs(tb.percent) - Math.abs(ta.percent));
    });
}
/**
 * Build the candidate list from a diff and today's raw snapshot.
 *
 * 按代表趋势的 percent 正负拆成三组：
 *   up   —— 上涨候选（percent > 0），找做多机会
 *   down —— 下跌候选（percent < 0），找卖点/规避
 *   neutral —— 无区间趋势（仅有 reason_list 异动点）
 *
 * 每组内按"进行中 > 持续长 > 幅度大"排序。
 *
 * @param diff 第2层 diff 结果
 * @param rawToday 今日 raw 快照（top_trend 取自此处的完整 range 列表）
 */
function buildCandidates(diff, rawToday) {
    // 扫描日 23:59:59 的毫秒时间戳，用于判断 ongoing
    const scanEndMs = Date.parse(rawToday.end_date + "T23:59:59+08:00") || rawToday.end_ms;
    const up = [];
    const down = [];
    const neutral = [];
    for (const change of diff.changes) {
        const rawEntry = rawToday.stocks[change.ticker];
        const topTrend = pickTopTrend(rawEntry?.range_reason_list, scanEndMs);
        const entry = {
            ticker: change.ticker,
            name: change.name,
            top_trend: topTrend,
            new_today: {
                reasons: change.new_reason_points.length,
                ranges: change.new_range_trends.length,
            },
        };
        if (!topTrend) {
            neutral.push(entry);
        }
        else if (topTrend.percent > 0) {
            up.push(entry);
        }
        else {
            down.push(entry);
        }
    }
    return {
        scan_date: diff.scan_date,
        up: sortGroup(up),
        down: sortGroup(down),
        neutral,
    };
}
//# sourceMappingURL=candidates.js.map