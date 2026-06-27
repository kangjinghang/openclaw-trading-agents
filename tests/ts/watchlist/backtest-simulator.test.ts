import { describe, it, expect } from "vitest";
import { PositionSimulator } from "../../../src/watchlist/backtest-simulator";
import type { RebalancePipelineResult } from "../../../src/watchlist/rebalancer";
import type { Action } from "../../../src/watchlist/rebalance-types";

// ── 测试工具 ──────────────────────────────────────────────────────────

/** 内存价格表 PriceLookup：ticker → { date → close }。
 *  找不到精确日期时回退到 ≤ date 的最近价。 */
function makePriceLookup(table: Record<string, Record<string, number>>) {
  return async (ticker: string, date: string): Promise<number | null> => {
    const byDate = table[ticker];
    if (!byDate) return null;
    if (byDate[date] !== undefined) return byDate[date];
    const before = Object.entries(byDate)
      .filter(([d]) => d <= date)
      .sort((a, b) => b[0].localeCompare(a[0]));
    return before.length > 0 ? before[0][1] : null;
  };
}

/** 构造 BUY action。 */
function buyAction(ticker: string, name: string, weight: number): Action {
  return {
    action: "BUY", ticker, name,
    current_weight: 0, target_weight: weight, delta: weight,
    reason: "test", priority: 3,
  };
}

/** 构造 SELL action。 */
function sellAction(ticker: string, name: string, currentWeight: number): Action {
  return {
    action: "SELL", ticker, name,
    current_weight: currentWeight, target_weight: 0, delta: -currentWeight,
    reason: "test stop loss", priority: 1,
  };
}

/** 构造 ADD action（加仓到 target）。 */
function addAction(ticker: string, name: string, currentWeight: number, targetWeight: number): Action {
  return {
    action: "ADD", ticker, name,
    current_weight: currentWeight, target_weight: targetWeight, delta: targetWeight - currentWeight,
    reason: "test add", priority: 4,
  };
}

/** 构造 REDUCE action（减仓到 target）。 */
function reduceAction(ticker: string, name: string, currentWeight: number, targetWeight: number): Action {
  return {
    action: "REDUCE", ticker, name,
    current_weight: currentWeight, target_weight: targetWeight, delta: targetWeight - currentWeight,
    reason: "test reduce", priority: 2,
  };
}

/** 构造最小 RebalancePipelineResult（applyPlan 只读 actions + status）。 */
function makeResult(actions: Action[]): RebalancePipelineResult {
  return {
    reports: [],
    rebalancer_output: {
      evaluations: [],
      actions,
      portfolio_after: { positions: [], cash_pct: 0.5 },
      summary: "",
    },
    constraint_check: { passed: true, violations: [], revise_count: 0 },
    execution_plan: { execution_sequence: [], final_state: { positions: [], cash_pct: 0.5 }, warnings: [] },
    status: "ok",
    sector_warnings: [],
    position_traces: {},
  };
}

const D1 = "2026-06-17";
const D2 = "2026-06-18";
const D3 = "2026-06-19";

// ── 序列化往返 ────────────────────────────────────────────────────────

describe("PositionSimulator.serialize / fromSerialized 往返", () => {
  it("空状态往返保持一致", () => {
    const lookup = makePriceLookup({});
    const sim = new PositionSimulator(lookup);
    const s = sim.serialize();
    const restored = PositionSimulator.fromSerialized(s, lookup);

    expect(restored.serialize()).toEqual(s);
    expect(s.cash).toBe(1.0);
    expect(s.positions).toHaveLength(0);
    expect(s.navHistory).toHaveLength(0);
    expect(s.trades).toHaveLength(0);
    expect(s.lastRebalanceDate).toBeNull();
  });

  it("有持仓/交易/NAV 的完整状态往返无损", async () => {
    // 600519 在 D1 建仓 10%，D2 涨到 11，D3 卖出
    const lookup = makePriceLookup({
      "SH600519": { [D1]: 100, [D2]: 110, [D3]: 105 },
    });
    const sim = new PositionSimulator(lookup);

    // D1: BUY 10%
    await sim.normalizeWeights(D1);
    await sim.applyPlan(
      makeResult([buyAction("SH600519", "贵州茅台", 0.10)]),
      D1,
      new Map([["SH600519", { fitness_score: 7, name: "贵州茅台", sector: "白酒" }]]),
    );
    await sim.recordNav(D1, [buyAction("SH600519", "贵州茅台", 0.10)], sim.getPrevNav());

    // D2: 价格漂移（normalizeWeights 重算权重）
    await sim.normalizeWeights(D2);
    await sim.recordNav(D2, [], sim.getPrevNav());

    const before = sim.serialize();
    expect(before.positions).toHaveLength(1);
    expect(before.positions[0].ticker).toBe("SH600519");
    expect(before.cash).toBeLessThan(1.0);  // 花了现金买股
    expect(before.navHistory).toHaveLength(2);

    // 序列化 → 反序列化
    const restored = PositionSimulator.fromSerialized(before, lookup);
    const after = restored.serialize();

    expect(after.cash).toBe(before.cash);
    expect(after.positions).toEqual(before.positions);
    expect(after.navHistory).toEqual(before.navHistory);
    expect(after.trades).toEqual(before.trades);
    expect(after.lastRebalanceDate).toBe(before.lastRebalanceDate);
    expect(after.recentSells).toEqual(before.recentSells);
  });
});

// ── currentHoldingsSnapshot ───────────────────────────────────────────

describe("PositionSimulator.currentHoldingsSnapshot", () => {
  it("返回浮动盈亏，不记入 trades", async () => {
    const lookup = makePriceLookup({
      "SH600519": { [D1]: 100, [D2]: 120 },
      "SZ000001": { [D1]: 10, [D2]: 9 },
    });
    const sim = new PositionSimulator(lookup);

    await sim.normalizeWeights(D1);
    await sim.applyPlan(
      makeResult([
        buyAction("SH600519", "贵州茅台", 0.10),
        buyAction("SZ000001", "平安银行", 0.08),
      ]),
      D1,
      new Map([
        ["SH600519", { fitness_score: 7, name: "贵州茅台", sector: "白酒" }],
        ["SZ000001", { fitness_score: 6, name: "平安银行", sector: "银行" }],
      ]),
    );

    // D2：价格变动后查浮动盈亏
    const priceMap = await sim.normalizeWeights(D2);
    const holdings = await sim.currentHoldingsSnapshot(D2, priceMap);

    expect(holdings).toHaveLength(2);
    // 按权重降序
    expect(holdings[0].weight).toBeGreaterThanOrEqual(holdings[1].weight);

    const maotai = holdings.find(h => h.ticker === "SH600519")!;
    expect(maotai.returnPct).toBeCloseTo(20, 0);   // 100→120, +20%

    const bank = holdings.find(h => h.ticker === "SZ000001")!;
    expect(bank.returnPct).toBeCloseTo(-10, 0);    // 10→9, -10%

    // 关键：trades 数组未被污染（closeOpenPositions 才会记入）
    expect(sim.serialize().trades).toHaveLength(0);
  });
});

// ── 增量衔接（跨进程续跑核心场景） ────────────────────────────────────

describe("增量回测：Day1 存 state → 新实例 Day2 续跑", () => {
  it("新实例从 state 恢复后，prevNav 衔接正确，NAV 曲线连续", async () => {
    // 600519 D1=100, D2=110（涨 10%）
    const lookup = makePriceLookup({
      "SH600519": { [D1]: 100, [D2]: 110 },
    });

    // === 进程 A：跑 Day1 ===
    const simA = new PositionSimulator(lookup);
    await simA.normalizeWeights(D1);
    await simA.applyPlan(
      makeResult([buyAction("SH600519", "贵州茅台", 0.10)]),
      D1,
      new Map([["SH600519", { fitness_score: 7, name: "贵州茅台", sector: "白酒" }]]),
    );
    await simA.recordNav(D1, [buyAction("SH600519", "贵州茅台", 0.10)], simA.getPrevNav());

    const state = simA.serialize();
    const navAfterD1 = state.navHistory[0].nav;
    expect(navAfterD1).toBeGreaterThan(0);

    // === 进程 B：新实例从 state 恢复，跑 Day2 ===
    const simB = PositionSimulator.fromSerialized(state, lookup);

    // 关键验证：getPrevNav 必须返回 Day1 记录的真实 NAV（而非重算）
    expect(simB.getPrevNav()).toBe(navAfterD1);

    // Day2：价格漂移后记录 NAV
    const priceMap = await simB.normalizeWeights(D2);
    await simB.recordNav(D2, [], simB.getPrevNav());

    const finalState = simB.serialize();
    expect(finalState.navHistory).toHaveLength(2);

    // NAV 曲线连续：Day2 的 dailyReturn 基于 Day1 的真实 NAV
    const day1 = finalState.navHistory[0];
    const day2 = finalState.navHistory[1];
    expect(day1.date).toBe(D1);
    expect(day2.date).toBe(D2);

    // 持仓 10% 在 D1→D2 涨 10%，组合涨幅 ≈ 1%（10% × 10%）
    // dailyReturn = (day2.nav / day1.nav - 1) × 100，应略大于 0
    expect(day2.dailyReturnPct).toBeGreaterThan(0);
    expect(day2.nav).toBeGreaterThan(day1.nav);
  });

  it("增量续跑后再卖出，交易记录完整（建仓日正确）", async () => {
    const lookup = makePriceLookup({
      "SH600519": { [D1]: 100, [D2]: 110, [D3]: 105 },
    });

    // 进程 A：Day1 建仓
    const simA = new PositionSimulator(lookup);
    await simA.normalizeWeights(D1);
    await simA.applyPlan(
      makeResult([buyAction("SH600519", "贵州茅台", 0.10)]),
      D1,
      new Map([["SH600519", { fitness_score: 7, name: "贵州茅台", sector: "白酒" }]]),
    );
    await simA.recordNav(D1, [buyAction("SH600519", "贵州茅台", 0.10)], simA.getPrevNav());

    // 进程 B：Day2 漂移 + recordNav
    const simB = PositionSimulator.fromSerialized(simA.serialize(), lookup);
    await simB.normalizeWeights(D2);
    await simB.recordNav(D2, [], simB.getPrevNav());

    // 进程 C：Day3 卖出
    const simC = PositionSimulator.fromSerialized(simB.serialize(), lookup);
    const priceMapD3 = await simC.normalizeWeights(D3);
    await simC.applyPlan(
      makeResult([sellAction("SH600519", "贵州茅台", priceMapD3.get("SH600519")! > 0 ? 0.1 : 0.1)]),
      D3,
      new Map([["SH600519", { fitness_score: 7, name: "贵州茅台", sector: "白酒" }]]),
      priceMapD3,
    );

    const finalState = simC.serialize();
    expect(finalState.trades).toHaveLength(1);
    const trade = finalState.trades[0];
    expect(trade.ticker).toBe("SH600519");
    expect(trade.entryDate).toBe(D1);       // 建仓日跨进程保留
    expect(trade.exitDate).toBe(D3);        // 平仓日正确
    expect(trade.returnPct).toBeCloseTo(5, 0);  // 100→105, +5%
    expect(trade.exitReason).toBe("test stop loss");
  });
});

// ── 手数取整（lotSize）──────────────────────────────────────────────
//
// realCapital + lotSize 让回测真实反映 A 股最小 1 手=100 股的约束：
// 20 万账户买 245 元的香农芯创，8% 仓位 = 1.6 万 → 65 股 < 1 手 → 实际买不了。
// 之前回测假装买进 65 股导致 NAV 失真，现在应跳过。

const CAPITAL = 200000;  // 20 万本金
const LOT = 100;         // A 股最小 1 手

describe("PositionSimulator 手数取整（BUY）", () => {
  it("高价股买不起 1 手 → 跳过，持仓 0，cash 不变", async () => {
    // 香农芯创 245 元，8% 仓位 = 1.6 万 → 65 股 < 100 → 跳过
    const lookup = makePriceLookup({ "SH688629": { [D1]: 245 } });
    const sim = new PositionSimulator(lookup, { realCapital: CAPITAL, lotSize: LOT });
    await sim.normalizeWeights(D1);
    const res = await sim.applyPlan(
      makeResult([buyAction("SH688629", "香农芯创", 0.08)]),
      D1,
      new Map(),
    );
    expect(res.skippedBuys).toHaveLength(1);
    expect(res.skippedBuys[0].ticker).toBe("SH688629");
    expect(sim.serialize().positions).toHaveLength(0);
    expect(sim.serialize().cash).toBe(1.0);  // 没花钱
  });

  it("正常股能买整手 → 成交", async () => {
    // 100 元，10% 仓位 = 2 万 → 200 股 = 2 手 → 成交
    const lookup = makePriceLookup({ "SH600000": { [D1]: 100 } });
    const sim = new PositionSimulator(lookup, { realCapital: CAPITAL, lotSize: LOT });
    await sim.normalizeWeights(D1);
    await sim.applyPlan(
      makeResult([buyAction("SH600000", "浦发银行", 0.10)]),
      D1,
      new Map([["SH600000", { fitness_score: 7, name: "浦发银行", sector: "银行" }]]),
    );
    const pos = sim.serialize().positions[0];
    expect(pos.shares).toBeCloseTo(200 / CAPITAL, 6);  // 归一化：200股/20万 = 0.001
    expect(pos.entry_price).toBe(100);
  });

  it("边界：恰好 100 股成交 1 手；99 股跳过", async () => {
    // 100 元，target 算出 100 股 → 仓位 = 100×100/200000 = 0.05
    const lookup = makePriceLookup({ "SH600001": { [D1]: 100 }, "SH600002": { [D1]: 100 } });
    const sim = new PositionSimulator(lookup, { realCapital: CAPITAL, lotSize: LOT });
    await sim.normalizeWeights(D1);
    const res = await sim.applyPlan(
      makeResult([
        buyAction("SH600001", "A股", 0.05),  // 100×100/20万=0.05 → 恰 100 股
        buyAction("SH600002", "B股", 0.0495), // 0.0495×20万/100=99 股 < 100 → 跳过
      ]),
      D1,
      new Map(),
    );
    const s = sim.serialize();
    const aPos = s.positions.find(p => p.ticker === "SH600001");
    expect(aPos).toBeDefined();               // 0.05 成交
    expect(aPos!.shares).toBeCloseTo(100 / CAPITAL, 6);
    expect(s.positions.find(p => p.ticker === "SH600002")).toBeUndefined();  // 0.0495 跳过
    expect(res.skippedBuys.map(b => b.ticker)).toEqual(["SH600002"]);
  });
});

describe("PositionSimulator 手数取整（ADD / REDUCE）", () => {
  it("ADD：加仓增量取整到整手，不足 1 手跳过加仓", async () => {
    // 先用旧 options 建一个非整数份额的仓（100 元 × 100 股），再 ADD 小额
    const lookup = makePriceLookup({ "SH600010": { [D1]: 100, [D2]: 100 } });
    // 进程 A：无 options 建仓 100 股（shares = 0.05 归一化 = 100 股）
    const sim = new PositionSimulator(lookup);  // 旧行为
    await sim.normalizeWeights(D1);
    await sim.applyPlan(
      makeResult([buyAction("SH600010", "测试", 0.05)]),  // 5% = 1万 = 100 股
      D1,
      new Map([["SH600010", { fitness_score: 7, name: "测试", sector: "X" }]]),
    );

    // 注入 realCapital 后 ADD：目标增量 50 股 < 100 → 取整为 0 → 不加仓
    // 注意：构造函数 options 只在构造时设定。这里用 fromSerialized 重建带 options 的实例
    const sim2 = PositionSimulator.fromSerialized(sim.serialize(), lookup, { realCapital: CAPITAL, lotSize: LOT });
    await sim2.normalizeWeights(D2);
    const before = sim2.serialize().positions[0].shares;
    // ADD 从 100 股加到 150 股 → 增量 50 股 < 100 → 跳过
    await sim2.applyPlan(
      makeResult([addAction("SH600010", "测试", 0.05, 0.075)]),  // 5%→7.5%, 增量 50 股
      D2,
      new Map([["SH600010", { fitness_score: 7, name: "测试", sector: "X" }]]),
    );
    expect(sim2.serialize().positions[0].shares).toBeCloseTo(before, 6);  // 没加
  });

  it("REDUCE：减仓股数取整，不足 1 手不动", async () => {
    const lookup = makePriceLookup({ "SH600020": { [D1]: 100, [D2]: 100 } });
    const sim = new PositionSimulator(lookup);  // 旧行为建仓
    await sim.normalizeWeights(D1);
    await sim.applyPlan(
      makeResult([buyAction("SH600020", "测试", 0.10)]),  // 10% = 2万 = 200 股
      D1,
      new Map([["SH600020", { fitness_score: 7, name: "测试", sector: "X" }]]),
    );

    // REDUCE 减半：200 股 → 目标 100 股，卖出 100 股 = 1 手 → 成交
    const sim2 = PositionSimulator.fromSerialized(sim.serialize(), lookup, { realCapital: CAPITAL, lotSize: LOT });
    await sim2.normalizeWeights(D2);
    await sim2.applyPlan(
      makeResult([reduceAction("SH600020", "测试", 0.10, 0.05)]),  // 10%→5%
      D2,
      new Map([["SH600020", { fitness_score: 7, name: "测试", sector: "X" }]]),
    );
    expect(sim2.serialize().positions[0].shares).toBeCloseTo(100 / CAPITAL, 6);  // 剩 100 股
  });
});

describe("PositionSimulator 手数取整（配置与兼容性）", () => {
  it("lotSize=200（科创板口径）生效", async () => {
    // 科创板最小 1 手=200 股。100 元，target 0.05 → 100 股 < 200 → 跳过
    const lookup = makePriceLookup({ "SH688099": { [D1]: 100 } });
    const sim = new PositionSimulator(lookup, { realCapital: CAPITAL, lotSize: 200 });
    await sim.normalizeWeights(D1);
    const res = await sim.applyPlan(
      makeResult([buyAction("SH688099", "科创A", 0.05)]),  // 0.05×20万/100=100 股 < 200
      D1,
      new Map(),
    );
    expect(res.skippedBuys).toHaveLength(1);
    expect(sim.serialize().positions).toHaveLength(0);
  });

  it("不传 options（旧行为）：shares 为浮点，skipped 永远空", async () => {
    // 旧逻辑：shares = targetValue/price，不取整
    const lookup = makePriceLookup({ "SH688629": { [D1]: 245 } });
    const sim = new PositionSimulator(lookup);  // 无 options
    await sim.normalizeWeights(D1);
    const res = await sim.applyPlan(
      makeResult([buyAction("SH688629", "香农", 0.08)]),
      D1,
      new Map([["SH688629", { fitness_score: 7, name: "香农", sector: "X" }]]),
    );
    expect(res.skippedBuys).toHaveLength(0);
    const pos = sim.serialize().positions[0];
    expect(pos).toBeDefined();
    expect(pos.shares).toBeCloseTo(0.08 / 245, 8);  // 归一化浮点，不取整
  });

  it("序列化往返保留 realCapital / lotSize", async () => {
    const lookup = makePriceLookup({ "SH600099": { [D1]: 100 } });
    const sim = new PositionSimulator(lookup, { realCapital: CAPITAL, lotSize: LOT });
    await sim.normalizeWeights(D1);
    await sim.applyPlan(
      makeResult([buyAction("SH600099", "测试", 0.10)]),
      D1,
      new Map([["SH600099", { fitness_score: 7, name: "测试", sector: "X" }]]),
    );
    const s = sim.serialize();
    expect(s.realCapital).toBe(CAPITAL);
    expect(s.lotSize).toBe(LOT);
    // fromSerialized 恢复后仍按取整逻辑工作
    const restored = PositionSimulator.fromSerialized(s, lookup);
    expect(restored.serialize().realCapital).toBe(CAPITAL);
    expect(restored.serialize().lotSize).toBe(LOT);
  });
});
