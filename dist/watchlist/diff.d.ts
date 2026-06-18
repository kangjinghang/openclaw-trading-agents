import type { RawSnapshotFile, DiffFile } from "./types";
/** 从 raw 快照的数据现算「雪球最新交易日」的毫秒时间戳（归一化到当天 00:00 北京时间）。
 *  = max(所有 reason.timestamp ∪ 所有 range.end)，跳过 scan_error 的失败股，
 *    再向下取整到当天 00:00:00。
 *
 *  语义：这是"雪球数据视角的最新交易日"，不是日历今天——盘前抓的快照、或雪球当天
 *  还没更新时，这个值会早于 scan_date。diff 用它判断"今天仍在延续的趋势"是否 end 到位。
 *  全空数据返回 0。 */
export declare function computeDataDateMs(raw: RawSnapshotFile): number;
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
export declare function computeDiff(today: RawSnapshotFile, baseline: RawSnapshotFile | null): DiffFile;
//# sourceMappingURL=diff.d.ts.map