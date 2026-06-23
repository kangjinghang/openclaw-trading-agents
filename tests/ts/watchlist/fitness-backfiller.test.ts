// tests/ts/watchlist/fitness-backfiller.test.ts
// 懒结算测试：mock execSkillScript 返回固定 K 线，断言按日期算对 return_7d/14d/30d。
// 验证：到期结算、未到期跳过、entry_price 从 kline 重拉、kline 失败部分结算、幂等。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

vi.mock("../../../src/exec-python", () => ({
  execSkillScript: vi.fn(),
}));

import { FitnessHistoryStore, type FitnessRecord } from "../../../src/watchlist/fitness-history-store";
import { backfillReturns } from "../../../src/watchlist/fitness-backfiller";
import { execSkillScript } from "../../../src/exec-python";

/** 构造 K 线 stub：decision_date + 之后 7/14/30 天的收盘价。 */
function mockKline(prices: { date: string; close: number }[], success = true) {
  vi.mocked(execSkillScript).mockImplementation(async () => ({
    success,
    data: { data: prices },
  }) as any);
}

function makeRecord(overrides: Partial<FitnessRecord> = {}): FitnessRecord {
  return {
    decision_date: "2026-05-01",  // 30+ 天前
    ticker: "SZ300319",
    name: "麦捷科技",
    action: "BUY",
    fitness: 8,
    overall_risk: "medium",
    target_weight: 0.03,
    entry_price: 0,  // 留 0，让 backfiller 从 kline 重拉
    run_id: "rebalance-2026-05-01",
    status: "open",
    ...overrides,
  };
}

describe("backfillReturns", () => {
  let tmpDir: string;
  let store: FitnessHistoryStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fitness-backfill-"));
    store = new FitnessHistoryStore(tmpDir);
    vi.mocked(execSkillScript).mockReset();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("到期记录：从 kline 算 7/14/30 天收益 + entry_price 重拉", async () => {
    // decision 2026-05-01 entry=10，+7d(+10%)=11，+14d(+20%)=12，+30d(+50%)=15
    store.appendDecisions([makeRecord({ ticker: "A" })]);
    mockKline([
      { date: "2026-05-01", close: 10 },
      { date: "2026-05-08", close: 11 },  // +7d
      { date: "2026-05-15", close: 12 },  // +14d
      { date: "2026-05-31", close: 15 },  // +30d
    ]);
    const r = await backfillReturns(store, "2026-06-23");
    expect(r.settled).toBe(1);
    const rec = store.read().records[0];
    expect(rec.status).toBe("settled");
    expect(rec.return_7d).toBe(10);   // (11-10)/10 = 10%
    expect(rec.return_14d).toBe(20);
    expect(rec.return_30d).toBe(50);
  });

  it("未到期（<30 天）：跳过，不结算", async () => {
    store.appendDecisions([makeRecord({ decision_date: "2026-06-15" })]);  // 8 天前
    mockKline([]);
    const r = await backfillReturns(store, "2026-06-23");
    expect(r.skipped).toBe(1);
    expect(r.settled).toBe(0);
    expect(store.read().records[0].status).toBe("open");  // 仍 open
  });

  it("kline 失败 → 该记录标 settled 但 return 全 undefined（部分结算）", async () => {
    store.appendDecisions([makeRecord({ ticker: "A" })]);
    mockKline([], false);  // success=false
    const r = await backfillReturns(store, "2026-06-23");
    expect(r.failed).toBe(1);
    const rec = store.read().records[0];
    expect(rec.status).toBe("settled");  // 仍标 settled（避免反复尝试）
    expect(rec.return_7d).toBeUndefined();
  });

  it("找不到 +30d 价格（kline 不够长）→ 该窗口 undefined，其余算", async () => {
    store.appendDecisions([makeRecord({ ticker: "A" })]);
    mockKline([
      { date: "2026-05-01", close: 10 },
      { date: "2026-05-08", close: 11 },   // +7d 有
      // +14d 缺，+30d 缺
    ]);
    const r = await backfillReturns(store, "2026-06-23");
    expect(r.settled).toBe(1);  // 有一个窗口算出来就算 settled
    const rec = store.read().records[0];
    expect(rec.return_7d).toBe(10);
    expect(rec.return_14d).toBeUndefined();
    expect(rec.return_30d).toBeUndefined();
  });

  it("幂等：已 settled 的不再重算", async () => {
    store.appendDecisions([makeRecord({ ticker: "A" })]);
    mockKline([
      { date: "2026-05-01", close: 10 },
      { date: "2026-05-08", close: 11 },
      { date: "2026-05-15", close: 12 },
      { date: "2026-05-31", close: 15 },
    ]);
    await backfillReturns(store, "2026-06-23");  // 第一次结算
    const firstCalls = vi.mocked(execSkillScript).mock.calls.length;
    await backfillReturns(store, "2026-06-23");  // 第二次，应幂等
    expect(vi.mocked(execSkillScript).mock.calls.length).toBe(firstCalls);  // 没多调 kline
  });

  it("多条 open：逐条结算，统计正确", async () => {
    store.appendDecisions([
      makeRecord({ ticker: "A", decision_date: "2026-05-01" }),  // 到期
      makeRecord({ ticker: "B", decision_date: "2026-06-15" }),  // 未到期
      makeRecord({ ticker: "C", decision_date: "2026-05-01" }),  // 到期
    ]);
    mockKline([
      { date: "2026-05-01", close: 10 },
      { date: "2026-05-08", close: 11 },
      { date: "2026-05-15", close: 12 },
      { date: "2026-05-31", close: 15 },
    ]);
    const r = await backfillReturns(store, "2026-06-23");
    expect(r.settled).toBe(2);   // A, C
    expect(r.skipped).toBe(1);   // B
  });

  it("空 store → 全 0", async () => {
    const r = await backfillReturns(store, "2026-06-23");
    expect(r).toEqual({ settled: 0, skipped: 0, failed: 0 });
  });
});
