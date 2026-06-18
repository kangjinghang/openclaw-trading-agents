import type { RawSnapshotFile, DiffFile, DiffChange, RawReason, RawRange } from "./types";

/** 取 range 列表中 end 最大的(即"最新一个"区间);空数组返回 null。
 * 雪球的 range.end 总是某天 00:00:00 北京时间,end 越大 = 越近。 */
function latestRange(ranges: RawRange[] | undefined): RawRange | null {
  if (!ranges || ranges.length === 0) return null;
  return ranges.reduce((a, b) => (b.end > a.end ? b : a));
}

/** 一天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 把任意毫秒时间戳向下取整到「当天 00:00:00 北京时间」。
 *
 * 防御性归一化：雪球的 range.end / reason.timestamp 实测都是"某天 00:00:00 北京"精度，
 * 本函数确保万一某天返回非 00:00 精度时锚点仍是 00:00，与 range.end 的 === 比较成立。
 * 对正常 00:00 数据是 no-op。
 *
 * 注意：raw 顶层的 end_ms（snapshot 写的查询上界 23:59:59）不参与 computeDataDateMs
 * ——后者只读 stocks 里的 reason.timestamp / range.end。
 *
 * 北京时间 UTC+8：一个北京日期的 00:00 = UTC 前一天 16:00。
 * 用 `ms + 8h` 后对齐到"北京日的边界"再取整，最后减回 8h。 */
function toBeijingMidnight(ms: number): number {
  const OFFSET = 8 * 60 * 60 * 1000;
  return Math.floor((ms + OFFSET) / DAY_MS) * DAY_MS - OFFSET;
}

/** 从 raw 快照的数据现算「雪球最新交易日」的毫秒时间戳（归一化到当天 00:00 北京时间）。
 *  = max(所有 reason.timestamp ∪ 所有 range.end)，跳过 scan_error 的失败股，
 *    再向下取整到当天 00:00:00。
 *
 *  语义：这是"雪球数据视角的最新交易日"，不是日历今天——盘前抓的快照、或雪球当天
 *  还没更新时，这个值会早于 scan_date。diff 用它判断"今天仍在延续的趋势"是否 end 到位。
 *  全空数据返回 0。 */
export function computeDataDateMs(raw: RawSnapshotFile): number {
  let maxTs = 0;
  for (const entry of Object.values(raw.stocks)) {
    if (entry.scan_error) continue;
    for (const r of entry.reason_list ?? []) {
      if (r.timestamp > maxTs) maxTs = r.timestamp;
    }
    for (const rg of entry.range_reason_list ?? []) {
      if (rg.end > maxTs) maxTs = rg.end;
    }
  }
  // 无数据(maxTs=0)直接返回 0，不归一化（归一化 0 会得到负数时区偏移，无意义）
  return maxTs === 0 ? 0 : toBeijingMidnight(maxTs);
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
export function computeDiff(today: RawSnapshotFile, baseline: RawSnapshotFile | null): DiffFile {
  const changes: DiffChange[] = [];
  // 今天 00:00:00 北京时间的毫秒时间戳(雪球 range.end 的精度)
  const todayStartMs = computeDataDateMs(today);

  for (const [ticker, todayEntry] of Object.entries(today.stocks)) {
    if (todayEntry.scan_error) continue;

    const baselineEntry = baseline?.stocks?.[ticker];

    // A 类:最新 reason 是今天 + description 含"涨"(只认今日上涨事件)
    // description 由雪球生成,通常格式"...收盘价X元，涨幅Y%"/"...涨停..."
    const todayReasons: RawReason[] = (todayEntry.reason_list ?? []).filter(
      (r) => r.timestamp === todayStartMs && !!r.description && r.description.includes("涨"),
    );

    // range 比较:只看最新一个(end 最大的)
    const todayLatest = latestRange(todayEntry.range_reason_list);
    const baselineLatest = latestRange(baselineEntry?.range_reason_list);

    const continuedRanges: RawRange[] = [];
    const newRanges: RawRange[] = [];

    // B 类:最新 range end 是今天 + 上涨(percent > 0)
    if (todayLatest && todayLatest.end === todayStartMs && todayLatest.percent > 0) {
      const sameBegin = baselineLatest && baselineLatest.begin === todayLatest.begin;
      const baselineEndIsAlsoToday = baselineLatest && baselineLatest.end === todayStartMs;

      if (sameBegin && !baselineEndIsAlsoToday) {
        // B1 延续型:begin 相同,baseline 的 end 还没到今天 → today 把 end 推到了今天
        continuedRanges.push(todayLatest);
      } else if (!sameBegin) {
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
