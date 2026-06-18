import { describe, it, expect } from "vitest";
import { computeDiff, computeDataDateMs } from "../../../src/watchlist/diff";
import type { RawSnapshotFile } from "../../../src/watchlist/types";

function makeSnapshot(date: string, stocks: Record<string, any>): RawSnapshotFile {
  return {
    scan_date: date, begin_ms: 0, end_ms: 0, begin_date: date, end_date: date,
    window_months: 14, scanned: 0, succeeded: 0, failed: 0, stocks,
  };
}

/** 雪球 range.end 总是某天 00:00:00 北京时间,用此 helper 构造 */
function dayMs(dateStr: string): number {
  return Date.parse(dateStr + "T00:00:00+08:00");
}

const TODAY = "2026-06-18";
const TODAY_MS = dayMs(TODAY);
const YESTERDAY_MS = dayMs("2026-06-17");
const PAST_MS = dayMs("2026-03-01");

describe("computeDiff", () => {
  it("A: selects stock when latest reason timestamp is today AND description contains '涨'", () => {
    // 跟 range 的 B1/B2 完全对称:看最新一条的 timestamp
    const baseline = makeSnapshot("2026-06-17", {
      "SH688146": { name: "x", reason_list: [
        { timestamp: 1000, reason: "old in baseline" },
      ] },
    });
    const today = makeSnapshot(TODAY, {
      "SH688146": {
        name: "x",
        reason_list: [
          { timestamp: 1000, description: "old", reason: "old" },
          { timestamp: YESTERDAY_MS, description: "昨日涨幅5%", reason: "yesterday" },
          { timestamp: TODAY_MS, description: "今日涨幅10.5%", reason: "new today" },
        ],
      },
    });
    const diff = computeDiff(today, baseline);
    expect(diff.changes[0].today_reason_points).toEqual([
      { timestamp: TODAY_MS, description: "今日涨幅10.5%", reason: "new today" },
    ]);
  });

  it("A dropped: latest reason description 不含 '涨' (今日下跌)", () => {
    const baseline = makeSnapshot("2026-06-17", {});
    const today = makeSnapshot(TODAY, {
      "SH000031": {
        name: "x",
        reason_list: [
          { timestamp: 1000, description: "old", reason: "old" },
          { timestamp: TODAY_MS, description: "今日跌幅6.15%", reason: "today drop" },
        ],
      },
    });
    const diff = computeDiff(today, baseline);
    // 最新 reason 是今天但 description 是"跌幅"→ 不入选
    expect(diff.changes).toHaveLength(0);
  });

  it("A dropped: latest reason timestamp 不是今天 (雪球最近没更新该股)", () => {
    const baseline = makeSnapshot("2026-06-17", {});
    const today = makeSnapshot(TODAY, {
      "SH600519": {
        name: "x",
        reason_list: [
          { timestamp: 1000, reason: "old" },
          { timestamp: YESTERDAY_MS, reason: "yesterday" },  // 最新一条是昨天
        ],
      },
    });
    const diff = computeDiff(today, baseline);
    expect(diff.changes).toHaveLength(0);
  });

  it("B1: continued when today latest end=today + baseline latest has same begin with earlier end", () => {
    const baseline = makeSnapshot("2026-06-17", {
      "SH688146": { name: "x", range_reason_list: [
        { begin: 100, end: YESTERDAY_MS, type: "LONG", percent: 10, summary: "", points: "" },
      ] },
    });
    const today = makeSnapshot(TODAY, {
      "SH688146": { name: "x", range_reason_list: [
        { begin: 100, end: TODAY_MS, type: "LONG", percent: 50, summary: "", points: "" },
      ] },
    });
    const diff = computeDiff(today, baseline);
    expect(diff.changes[0].continued_ranges).toEqual([
      { begin: 100, end: TODAY_MS, type: "LONG", percent: 50, summary: "", points: "" },
    ]);
    expect(diff.changes[0].new_ranges).toEqual([]);
  });

  it("B1 静止型 dropped: today latest 完全等于 baseline latest (begin + end 都相同)", () => {
    // 边界:baseline 是昨天扫的,但 range.end 已经是今天(雪球提前算出来)
    // today 扫出来 begin+end 都相同 → 没新东西 → 不选
    const baseline = makeSnapshot("2026-06-17", {
      "SH688146": { name: "x", range_reason_list: [
        { begin: 100, end: TODAY_MS, type: "LONG", percent: 10, summary: "", points: "" },
      ] },
    });
    const today = makeSnapshot(TODAY, {
      "SH688146": { name: "x", range_reason_list: [
        { begin: 100, end: TODAY_MS, type: "LONG", percent: 50, summary: "", points: "" },
      ] },
    });
    const diff = computeDiff(today, baseline);
    expect(diff.changes).toHaveLength(0);
  });

  it("B1 dropped: today latest end 不是今天 (begin 相同但 end 没推到今天)", () => {
    const baseline = makeSnapshot("2026-06-17", {
      "SH688146": { name: "x", range_reason_list: [
        { begin: 100, end: PAST_MS, type: "LONG", percent: 10, summary: "", points: "" },
      ] },
    });
    const today = makeSnapshot(TODAY, {
      "SH688146": { name: "x", range_reason_list: [
        { begin: 100, end: YESTERDAY_MS, type: "LONG", percent: 50, summary: "", points: "" },
      ] },
      // 添加一个 dummy 股确保 computeDataDateMs 返回 TODAY_MS（而非 YESTERDAY_MS）
      // percent < 0 确保 dummy 自己不会被选中
      "DUMMY": { name: "dummy", range_reason_list: [{ begin: 999, end: TODAY_MS, type: "LONG", percent: -1 }] },
    });
    const diff = computeDiff(today, baseline);
    // end 从 PAST_MS → YESTERDAY_MS 变大了,但不是今天 → 不选
    expect(diff.changes).toHaveLength(0);
  });

  it("B2 新成型: today latest end=today + baseline latest begin 不同", () => {
    const baseline = makeSnapshot("2026-06-17", {
      "SH688146": { name: "x", range_reason_list: [
        { begin: 100, end: YESTERDAY_MS, type: "LONG", percent: 10, summary: "", points: "" },
      ] },
    });
    const today = makeSnapshot(TODAY, {
      "SH688146": { name: "x", range_reason_list: [
        { begin: 200, end: TODAY_MS, type: "LONG", percent: 50, summary: "", points: "" },
      ] },
    });
    const diff = computeDiff(today, baseline);
    expect(diff.changes[0].new_ranges).toEqual([
      { begin: 200, end: TODAY_MS, type: "LONG", percent: 50, summary: "", points: "" },
    ]);
    expect(diff.changes[0].continued_ranges).toEqual([]);
  });

  it("B2 新成型: baseline 无 range_reason_list", () => {
    const baseline = makeSnapshot("2026-06-17", {
      "SH688146": { name: "x" },
    });
    const today = makeSnapshot(TODAY, {
      "SH688146": { name: "x", range_reason_list: [
        { begin: 200, end: TODAY_MS, type: "LONG", percent: 50, summary: "", points: "" },
      ] },
    });
    const diff = computeDiff(today, baseline);
    expect(diff.changes[0].new_ranges).toHaveLength(1);
    expect(diff.changes[0].continued_ranges).toEqual([]);
  });

  it("B2 dropped: today latest end < today (雪球补历史 / 短期已结束)", () => {
    const baseline = makeSnapshot("2026-06-17", {});
    const today = makeSnapshot(TODAY, {
      "SH688146": { name: "x", range_reason_list: [
        { begin: 100, end: PAST_MS, type: "LONG", percent: 50, summary: "", points: "" },
      ] },
      // 添加一个 dummy 股确保 computeDataDateMs 返回 TODAY_MS（而非 PAST_MS）
      // percent < 0 确保 dummy 自己不会被选中
      "DUMMY": { name: "dummy", range_reason_list: [{ begin: 999, end: TODAY_MS, type: "LONG", percent: -1 }] },
    });
    const diff = computeDiff(today, baseline);
    expect(diff.changes).toHaveLength(0);
  });

  it("取 end 最大的作为最新一个 (多个 range 时)", () => {
    const baseline = makeSnapshot("2026-06-17", {});
    const today = makeSnapshot(TODAY, {
      "SH688146": { name: "x", range_reason_list: [
        { begin: 100, end: YESTERDAY_MS, type: "LONG", percent: 10, summary: "older", points: "" },
        { begin: 200, end: TODAY_MS, type: "LONG", percent: 50, summary: "latest", points: "" },
      ] },
    });
    const diff = computeDiff(today, baseline);
    expect(diff.changes[0].new_ranges).toEqual([
      { begin: 200, end: TODAY_MS, type: "LONG", percent: 50, summary: "latest", points: "" },
    ]);
  });

  it("skips stocks with scan_error", () => {
    const baseline = makeSnapshot("2026-06-17", {});
    const today = makeSnapshot(TODAY, {
      "SH000001": { name: "x", scan_error: "timeout" },
    });
    const diff = computeDiff(today, baseline);
    expect(diff.changes).toHaveLength(0);
  });

  it("first scan (baseline null): today latest end=today → B2", () => {
    const today = makeSnapshot(TODAY, {
      "SH688146": {
        name: "x",
        reason_list: [
          { timestamp: YESTERDAY_MS, description: "昨日涨幅5%", reason: "yesterday" },
          { timestamp: TODAY_MS, description: "今日涨幅10%", reason: "today" },
        ],
        range_reason_list: [
          { begin: 100, end: YESTERDAY_MS, type: "LONG", percent: 50, summary: "", points: "" },
          { begin: 200, end: TODAY_MS, type: "LONG", percent: 80, summary: "latest", points: "" },
        ],
      },
    });
    const diff = computeDiff(today, null);
    expect(diff.baseline).toBe("");
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].today_reason_points).toEqual([
      { timestamp: TODAY_MS, description: "今日涨幅10%", reason: "today" },
    ]);
    expect(diff.changes[0].new_ranges).toEqual([
      { begin: 200, end: TODAY_MS, type: "LONG", percent: 80, summary: "latest", points: "" },
    ]);
    expect(diff.changes[0].continued_ranges).toEqual([]);
  });

  it("B1/B2 dropped: percent < 0 (下跌区间不入选,与 reason 独立)", () => {
    // 即使 end=今天 + begin 与 baseline 相同,只要 percent < 0 → 丢弃
    const baseline = makeSnapshot("2026-06-17", {
      "SZ000031": { name: "x", range_reason_list: [
        { begin: 100, end: YESTERDAY_MS, type: "LONG", percent: -10, summary: "", points: "" },
      ] },
    });
    const today = makeSnapshot(TODAY, {
      "SZ000031": { name: "x", range_reason_list: [
        { begin: 100, end: TODAY_MS, type: "LONG", percent: -24, summary: "", points: "" },
      ] },
    });
    const diff = computeDiff(today, baseline);
    // B1 条件本应满足(end 今天+begin 相同),但 percent < 0 → 不入选
    expect(diff.changes).toHaveLength(0);
  });

  it("A 类独立于 B 类:reason 含涨 + range 下跌 → A 入选、B 不入选", () => {
    const baseline = makeSnapshot("2026-06-17", {});
    const today = makeSnapshot(TODAY, {
      "SH123456": {
        name: "x",
        reason_list: [
          { timestamp: TODAY_MS, description: "今日涨幅5%", reason: "today up" },
        ],
        range_reason_list: [
          { begin: 100, end: TODAY_MS, type: "LONG", percent: -15, summary: "", points: "" },
        ],
      },
    });
    const diff = computeDiff(today, baseline);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].today_reason_points).toHaveLength(1);
    expect(diff.changes[0].continued_ranges).toEqual([]);
    expect(diff.changes[0].new_ranges).toEqual([]);
  });

  it("todayStartMs 取自数据而非 end_date：数据日期 < end_date 时锚点跟随数据", () => {
    // 模拟节假日/盘中：文件名 end_date=06-18，但雪球数据最新只到 06-17
    // 旧逻辑(读 end_date)会因数据没 06-18 而 changes=[]（错）；新逻辑锚点=06-17 → B2 入选
    const baseline = makeSnapshot("2026-06-16", {});
    const today = makeSnapshot(TODAY, {  // TODAY="2026-06-18"，但数据里没有 06-18
      "SH688146": { name: "x", range_reason_list: [
        { begin: 200, end: YESTERDAY_MS, type: "LONG", percent: 50, summary: "", points: "" },
      ] },
    });
    const diff = computeDiff(today, baseline);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].new_ranges).toEqual([
      { begin: 200, end: YESTERDAY_MS, type: "LONG", percent: 50, summary: "", points: "" },
    ]);
  });

  it("computeDataDateMs: 取所有 reason.timestamp ∪ range.end 的最大值", () => {
    const snap = makeSnapshot(TODAY, {
      "A": { name: "x", reason_list: [{ timestamp: dayMs("2026-06-10") }], range_reason_list: [{ end: dayMs("2026-06-12") }] },
      "B": { name: "y", reason_list: [{ timestamp: dayMs("2026-06-15") }], range_reason_list: [] },
      "C": { name: "z", scan_error: "timeout" },  // 失败股跳过
    });
    // 最大值 = 06-15，归一化到当天 00:00 北京时间 = dayMs("2026-06-15")
    expect(computeDataDateMs(snap)).toBe(dayMs("2026-06-15"));
  });

  it("computeDataDateMs: 全空数据返回 0", () => {
    const snap = makeSnapshot(TODAY, {
      "A": { name: "x" },
      "B": { name: "y", scan_error: "timeout" },
    });
    expect(computeDataDateMs(snap)).toBe(0);
  });

  it("computeDataDateMs: 精度归一化 — reason.timestamp 带 23:59:59 也归一到当天 00:00", () => {
    // 雪球 range.end 恒为当天 00:00，但 snapshot.py 写的 end_ms 是当天 23:59:59。
    // 若数据里混入非 00:00 精度的时间戳，锚点必须归一到 00:00，否则与 range.end === 比较失败。
    const endOfDay = Date.parse("2026-06-15T23:59:59+08:00"); // 当天最晚一刻
    const snap = makeSnapshot(TODAY, {
      "A": { name: "x", reason_list: [{ timestamp: endOfDay }] },
    });
    expect(computeDataDateMs(snap)).toBe(dayMs("2026-06-15")); // 归一到 06-15 00:00
  });

  it("归一化 no-op：正常 00:00 数据下 computeDataDateMs 不改变值，B2 正常入选", () => {
    // 归一化对雪球正常的 00:00 精度数据是 no-op（toBeijingMidnight(00:00)===00:00），
    // 不影响 computeDiff 的 B2 判定。注：raw.end_ms（此处 23:59:59）不参与
    // computeDataDateMs（只读 stocks 内 reason/range），这里只是构造真实快照结构。
    const baseline = makeSnapshot("2026-06-17", {});
    const today: RawSnapshotFile = {
      scan_date: TODAY, begin_ms: 0,
      end_ms: Date.parse(TODAY + "T23:59:59+08:00"),  // 23:59:59（snapshot 实际写入的）
      begin_date: TODAY, end_date: TODAY,
      window_months: 14, scanned: 1, succeeded: 1, failed: 0,
      stocks: {
        "SH688146": { name: "x", range_reason_list: [
          { begin: 200, end: TODAY_MS, type: "LONG", percent: 50, summary: "", points: "" }, // end=00:00
        ] },
      },
    };
    const diff = computeDiff(today, baseline);
    expect(diff.changes).toHaveLength(1); // 归一化后锚点匹配，B2 入选
  });
});
