import { describe, it, expect } from "vitest";
import { formatRebalancerPrompt, parseRebalancePlan, rebalancePipeline } from "../../../src/watchlist/rebalancer";
import type { StockReport, Holdings, LastRebalance, RebalanceConstraints } from "../../../src/watchlist/rebalance-types";
import type { MacroView } from "../../../src/watchlist/data-fetcher";

const C: RebalanceConstraints = { single_name: 0.15, single_sector: 0.30, daily_turnover: 0.30, cash_reserve: 0.10 };

function makeReport(over: Partial<StockReport> = {}): StockReport {
  return {
    ticker: "SZ300319", name: "麦捷科技", sector: "电子",
    thesis: "x", fitness_score: 8, key_signals: [], data_gaps: [],
    risk_flags: [], overall_risk: "low", deal_breaker: false,
    is_held: false, current_weight: 0, days_held: 0, locked: false,
    ...over,
  };
}

describe("formatRebalancerPrompt", () => {
  it("包含约束 + 持仓 + reports", () => {
    const reports = [makeReport({ ticker: "SZ300319" })];
    const holdings: Holdings = { updated_at: "x", cash_pct: 0.15, positions: [] };
    const prompt = formatRebalancerPrompt(reports, holdings, null, C, 7);
    expect(prompt).toContain("0.15");
    expect(prompt).toContain("0.3");  // JS number formatting strips trailing zero
    expect(prompt).toContain("SZ300319 麦捷科技");
    expect(prompt).toContain('"cash_pct": 0.15');  // JSON format includes quotes
  });

  it("包含 last_rebalance（防反向）", () => {
    const last: LastRebalance = {
      date: "2026-06-14",
      actions: [{ action: "SELL", ticker: "SH600519", weight: 0.10 }],
    };
    const prompt = formatRebalancerPrompt([], { updated_at: "x", cash_pct: 1, positions: [] }, last, C, 7);
    expect(prompt).toContain("SH600519");
    expect(prompt).toContain("SELL");
  });

  it("macroView 注入：含市场倾向 + 景气/承压板块 + 大宗 + 引导语", () => {
    const macro: MacroView = {
      market_view: "震荡偏多",
      pmi_signal: "官方与财新PMI双口径共振向上",
      bullish_sectors: ["银行", "工程机械"],
      bearish_sectors: ["煤炭"],
      commodities: {
        AU0: { label: "黄金", chg_5d: 2.1, trend: "上行" },
        SC0: { label: "原油", chg_5d: -1.0, trend: "下行" },
        CU0: { label: "铜", chg_5d: 0.5, trend: "震荡/拐点" },
      },
    };
    const prompt = formatRebalancerPrompt([makeReport()], { updated_at: "x", cash_pct: 1, positions: [] }, null, C, 7, macro);
    expect(prompt).toContain("今日宏观环境");
    expect(prompt).toContain("震荡偏多");
    expect(prompt).toContain("官方与财新PMI双口径共振向上");
    expect(prompt).toContain("景气板块：银行、工程机械");
    expect(prompt).toContain("承压板块：煤炭");
    expect(prompt).toContain("黄金上行(+2.1%)");
    expect(prompt).toContain("宏观逆风的行业应谨慎加仓");
  });

  it("macroView=null → prompt 不含宏观段（向后兼容）", () => {
    const prompt = formatRebalancerPrompt([makeReport()], { updated_at: "x", cash_pct: 1, positions: [] }, null, C, 7, null);
    expect(prompt).not.toContain("今日宏观环境");
  });

  it("macroView 只有大宗（无 sector_view）→ 只渲染大宗段", () => {
    const macro: MacroView = {
      commodities: { AU0: { label: "黄金", trend: "上行", chg_5d: 3.0 } },
    };
    const prompt = formatRebalancerPrompt([makeReport()], { updated_at: "x", cash_pct: 1, positions: [] }, null, C, 7, macro);
    expect(prompt).toContain("今日宏观环境");
    expect(prompt).toContain("黄金上行(+3%)");
    expect(prompt).not.toContain("市场倾向");
    expect(prompt).not.toContain("景气板块");
  });
});

describe("parseRebalancePlan", () => {
  it("解析完整 JSON（含 evaluations + actions + portfolio_after）", () => {
    const validTickers = new Set(["SZ300319", "SH600519"]);
    const content = JSON.stringify({
      evaluations: [{ ticker: "SZ300319", judgment: "BUY", brief: "好" }],
      actions: [
        { action: "BUY", ticker: "SZ300319", name: "麦捷科技", current_weight: 0, target_weight: 0.10, delta: 0.10, reason: "x", priority: 3 },
      ],
      portfolio_after: { positions: [{ ticker: "SZ300319", weight: 0.10 }], cash_pct: 0.90 },
      summary: "x",
    });
    const plan = parseRebalancePlan(content, validTickers);
    expect(plan).not.toBeNull();
    expect(plan!.actions).toHaveLength(1);
    expect(plan!.actions[0]).toMatchObject({ action: "BUY", ticker: "SZ300319", priority: 3 });
    expect(plan!.portfolio_after.cash_pct).toBe(0.90);
  });

  it("过滤幻觉 ticker", () => {
    const valid = new Set(["A"]);
    const content = JSON.stringify({
      evaluations: [],
      actions: [
        { action: "BUY", ticker: "A", name: "a", current_weight: 0, target_weight: 0.10, delta: 0.10, reason: "r", priority: 3 },
        { action: "BUY", ticker: "FAKE", name: "fake", current_weight: 0, target_weight: 0.10, delta: 0.10, reason: "r", priority: 3 },
      ],
      portfolio_after: { positions: [], cash_pct: 0.80 },
      summary: "x",
    });
    const plan = parseRebalancePlan(content, valid)!;
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].ticker).toBe("A");
  });

  it("非 JSON 返回 null", () => {
    expect(parseRebalancePlan("not json", new Set())).toBeNull();
  });
});

import { runRebalanceWithRevise, type RebalanceLlmCaller } from "../../../src/watchlist/rebalancer";
import { DEFAULT_REBALANCE_CONFIG } from "../../../src/watchlist/rebalance-types";

describe("runRebalanceWithRevise", () => {
  // Helper: 构造合法 plan（sum=1, 单仓≤15%, etc.）
  const validTickers = new Set(["A", "B"]);
  const ctx = {
    sectors: new Map([["A", "x"], ["B", "y"]]),
    held: new Map() as Map<string, { days_held: number; locked: boolean }>,
    tickersInPool: validTickers,
    recentSoldTickers: new Set<string>(),
  };

  it("首次输出通过校验 → revise_count=0", async () => {
    const caller: RebalanceLlmCaller = async () => JSON.stringify({
      evaluations: [],
      actions: [
        { action: "HOLD", ticker: "A", name: "a", current_weight: 0.10, target_weight: 0.10, delta: 0, reason: "r", priority: 5 },
        { action: "HOLD", ticker: "B", name: "b", current_weight: 0.10, target_weight: 0.10, delta: 0, reason: "r", priority: 5 },
      ],
      portfolio_after: { positions: [{ ticker: "A", weight: 0.10 }, { ticker: "B", weight: 0.10 }], cash_pct: 0.80 },
      summary: "low activity",
    });
    const r = await runRebalanceWithRevise(caller, "fake-prompt", ctx, DEFAULT_REBALANCE_CONFIG);
    expect(r.reviseCount).toBe(0);
    expect(r.plan).not.toBeNull();
  });

  it("首次违反单仓 → revise 1 次后通过", async () => {
    let callIdx = 0;
    const caller: RebalanceLlmCaller = async () => {
      callIdx++;
      if (callIdx === 1) {
        return JSON.stringify({
          evaluations: [],
          actions: [{ action: "BUY", ticker: "A", name: "a", current_weight: 0, target_weight: 0.15, delta: 0.15, reason: "r", priority: 3 }],
          portfolio_after: { positions: [{ ticker: "A", weight: 0.15 }], cash_pct: 0.85 },
          summary: "x",
        });
      }
      return JSON.stringify({
        evaluations: [],
        actions: [{ action: "BUY", ticker: "A", name: "a", current_weight: 0, target_weight: 0.10, delta: 0.10, reason: "r", priority: 3 }],
        portfolio_after: { positions: [{ ticker: "A", weight: 0.10 }], cash_pct: 0.90 },
        summary: "x",
      });
    };
    const r = await runRebalanceWithRevise(caller, "fake-prompt", ctx, DEFAULT_REBALANCE_CONFIG);
    expect(r.reviseCount).toBe(1);
    expect(r.plan!.actions[0].target_weight).toBe(0.10);
  });

  it("revise 用尽 → status=constraint_violation + last_attempt 保留", async () => {
    const caller: RebalanceLlmCaller = async () => JSON.stringify({
      evaluations: [],
      actions: [{ action: "BUY", ticker: "A", name: "a", current_weight: 0, target_weight: 0.15, delta: 0.15, reason: "r", priority: 3 }],
      portfolio_after: { positions: [{ ticker: "A", weight: 0.15 }], cash_pct: 0.85 },
      summary: "x",
    });
    const r = await runRebalanceWithRevise(caller, "fake-prompt", ctx, DEFAULT_REBALANCE_CONFIG);
    expect(r.reviseCount).toBe(DEFAULT_REBALANCE_CONFIG.max_revise_retries);
    expect(r.status).toBe("constraint_violation");
    expect(r.plan).not.toBeNull();
  });

  it("全程 JSON 解析失败 → status=parse_failed + plan=null（区别于 constraint_violation）", async () => {
    const caller: RebalanceLlmCaller = async () => "totally not json at all";
    const r = await runRebalanceWithRevise(caller, "fake-prompt", ctx, DEFAULT_REBALANCE_CONFIG);
    expect(r.status).toBe("parse_failed");
    expect(r.plan).toBeNull();
    // 循环 attempt 0..max_revise_retries = 3 次尝试，每次 parse 失败都 reviseCount++
    // （JSON 重试与约束 revise 共用同一配额——这是设计上的有意取舍）
    expect(r.reviseCount).toBe(DEFAULT_REBALANCE_CONFIG.max_revise_retries + 1);
  });

  it("LLM 抛错 → status=llm_failed", async () => {
    const caller: RebalanceLlmCaller = async () => { throw new Error("network"); };
    const r = await runRebalanceWithRevise(caller, "fake-prompt", ctx, DEFAULT_REBALANCE_CONFIG);
    expect(r.status).toBe("llm_failed");
  });
});

import type { ShallowLlmCaller, StockData } from "../../../src/watchlist/shallow-analyzer";
import type { ScanSummary } from "../../../src/watchlist/types";
import type { RebalanceLlmCaller } from "../../../src/watchlist/rebalancer";

describe("rebalancePipeline (integration)", () => {
  it("完整 pipeline：候选 + 持仓 → rebalance → validate → execution_plan", async () => {
    const scan: ScanSummary = {
      scan_date: "2026-06-21", total_candidates: 178,
      groups: { LONG: { total: 35, ranked: 7, excluded: 5, fallback: false }, SHORT: { total: 44, pre_filter: 138, post_common_filter: 110, ranked: 8, excluded: 5, fallback: false } },
      top_picks: [
        { ticker: "SZ300319", name: "麦捷科技", score: 9.5, group: "LONG", percent: 134, days: 55, range_kind: "new", reason: "r" },
      ],
    };
    const holdings: Holdings = {
      updated_at: "x", cash_pct: 0.80,
      positions: [{ ticker: "SH600519", name: "贵州茅台", weight: 0.10, entry_price: 1700, entry_date: "2026-05-20", shares: 100, sector: "白酒" }],
    };
    const lastRebalance: LastRebalance = { date: "2026-06-14", actions: [] };

    const dataByTicker = new Map<string, StockData>([
      ["SZ300319", { ticker: "SZ300319", name: "麦捷科技", sector: "电子", kline: { pct_5d: 5, pct_20d: 20, support: 25, resistance: 30, volatility_20d: 0.015 }, news: [{ title: "n1" }], hot_money: { northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" }, fundamentals: { pe: 50, pb: 5, rev_q1: 1e9, np_q1: 1e8 } }],
      ["SH600519", { ticker: "SH600519", name: "贵州茅台", sector: "白酒", kline: { pct_5d: -1, pct_20d: 2, support: 1700, resistance: 1800, volatility_20d: 0.012 }, news: [], hot_money: { northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" }, fundamentals: { pe: 30, pb: 10, rev_q1: 4e9, np_q1: 2e9 } }],
    ]);

    const shallowCaller: ShallowLlmCaller = async ({ role }) => {
      if (role === "analyst") return JSON.stringify({ thesis: "thesis x", fitness_score: 8, data_freshness: "2026-06-21", key_signals: ["sig"], data_gaps: [] });
      return JSON.stringify({ risk_flags: [], overall_risk: "low", deal_breaker: false });
    };
    const rebalanceCaller: RebalanceLlmCaller = async () => JSON.stringify({
      evaluations: [
        { ticker: "SZ300319", judgment: "BUY", brief: "ok" },
        { ticker: "SH600519", judgment: "HOLD", brief: "hold" },
      ],
      actions: [
        // ⚠️ 注意：LLM 出的方向（BUY/HOLD）被采用，但 target_weight/delta 由公式覆盖
        // 趋势模式：fitness 8 × 0.008 = 6.4% × vol 1.0 = 6.4%
        { action: "BUY", ticker: "SZ300319", name: "麦捷科技", reason: "TLVR 电感放量" },
        { action: "HOLD", ticker: "SH600519", name: "贵州茅台", reason: "hold" },
      ],
      summary: "buy 麦捷科技",
    });

    const result = await rebalancePipeline({
      scan, holdings, lastRebalance, currentDate: "2026-06-21",
      shallowCaller, rebalanceCaller, dataByTicker,
    });

    expect(result.status).toBe("ok");
    expect(result.reports).toHaveLength(2);
    expect(result.rebalancer_output.actions).toHaveLength(2);

    // 趋势模式仓位计算器：SZ300319 fitness 8 → 8×0.008=6.4%（不是 LLM 的 0.10）
    const buyAction = result.rebalancer_output.actions.find(a => a.ticker === "SZ300319")!;
    expect(buyAction.action).toBe("BUY");
    expect(buyAction.target_weight).toBeCloseTo(0.064, 5);

    // SH600519 HOLD → 保持当前 10%
    const holdAction = result.rebalancer_output.actions.find(a => a.ticker === "SH600519")!;
    expect(holdAction.action).toBe("HOLD");
    expect(holdAction.target_weight).toBeCloseTo(0.10, 5);

    // execution plan：HOLD 过滤，只剩 BUY
    expect(result.execution_plan.execution_sequence).toHaveLength(1);
    expect(result.execution_plan.execution_sequence[0].action).toBe("BUY");
    expect(result.constraint_check.passed).toBe(true);

    // portfolio_after 权重和 = 1（6.4% + 10% + 83.6% cash）
    const totalWeight = result.rebalancer_output.portfolio_after.positions.reduce((s, p) => s + p.weight, 0);
    expect(totalWeight + result.rebalancer_output.portfolio_after.cash_pct).toBeCloseTo(1.0, 5);
  });

  it("deal_breaker 持仓：AI 出 HOLD 但代码强制改 SELL", async () => {
    const scan: ScanSummary = {
      scan_date: "2026-06-21", total_candidates: 0,
      groups: { LONG: { total: 0, ranked: 0, excluded: 0, fallback: false }, SHORT: { total: 0, pre_filter: 0, post_common_filter: 0, ranked: 0, excluded: 0, fallback: false } },
      top_picks: [],
    };
    const holdings: Holdings = {
      updated_at: "x", cash_pct: 0.80,
      positions: [{ ticker: "SH600519", name: "贵州茅台", weight: 0.20, entry_price: 1700, entry_date: "2026-05-20", shares: 100, sector: "白酒" }],
    };

    const dataByTicker = new Map<string, StockData>([
      ["SH600519", { ticker: "SH600519", name: "贵州茅台", sector: "白酒", kline: { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0.01 }, news: [], hot_money: { northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" }, fundamentals: { pe: 0, pb: 0, rev_q1: 0, np_q1: 0 } }],
    ]);

    // shallow-analyzer 标 deal_breaker
    const shallowCaller: ShallowLlmCaller = async ({ role }) => {
      if (role === "analyst") return JSON.stringify({ thesis: "x", fitness_score: 3, data_freshness: "2026-06-21", key_signals: [], data_gaps: [] });
      return JSON.stringify({ risk_flags: [{ flag: "财务造假", severity: "高", detail: "重大违规" }], overall_risk: "high", deal_breaker: true });
    };
    // AI 出 HOLD（漏判），但代码应强制 SELL
    const rebalanceCaller: RebalanceLlmCaller = async () => JSON.stringify({
      evaluations: [{ ticker: "SH600519", judgment: "HOLD", brief: "hold" }],
      actions: [{ action: "HOLD", ticker: "SH600519", name: "贵州茅台", reason: "hold" }],
      summary: "hold",
    });

    const result = await rebalancePipeline({
      scan, holdings, lastRebalance: null, currentDate: "2026-06-21",
      shallowCaller, rebalanceCaller, dataByTicker,
    });

    expect(result.status).toBe("ok");
    const action = result.rebalancer_output.actions[0];
    expect(action.action).toBe("SELL"); // deal_breaker 把 HOLD 改成 SELL
    expect(action.target_weight).toBe(0); // deal_breaker 强制清仓
    expect(result.rebalancer_output.portfolio_after.cash_pct).toBeCloseTo(1.0, 5); // 全现金
  });

  it("现金不足：BUY 降级为 HOLD（保留现金下限）", async () => {
    const scan: ScanSummary = {
      scan_date: "2026-06-21", total_candidates: 1,
      groups: { LONG: { total: 1, ranked: 1, excluded: 0, fallback: false }, SHORT: { total: 0, pre_filter: 0, post_common_filter: 0, ranked: 0, excluded: 0, fallback: false } },
      top_picks: [
        { ticker: "SZ300319", name: "麦捷科技", score: 9.5, group: "LONG", percent: 134, days: 55, range_kind: "new", reason: "r" },
      ],
    };
    // cash_pct = 0.10 = 现金下限 → spendable = 0 → BUY 买不起
    const holdings: Holdings = { updated_at: "x", cash_pct: 0.10, positions: [] };

    const dataByTicker = new Map<string, StockData>([
      // PE/净利 非零：让 fitness=9 不被质量门控规则1钳制，纯测现金排队降级路径
      ["SZ300319", { ticker: "SZ300319", name: "麦捷科技", sector: "电子", kline: { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0.01 }, news: [], hot_money: { northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" }, fundamentals: { pe: 30, pb: 5, rev_q1: 1e9, np_q1: 1e8 } }],
    ]);

    const shallowCaller: ShallowLlmCaller = async ({ role }) => {
      if (role === "analyst") return JSON.stringify({ thesis: "x", fitness_score: 9, data_freshness: "2026-06-21", key_signals: [], data_gaps: [] });
      return JSON.stringify({ risk_flags: [], overall_risk: "low", deal_breaker: false });
    };
    const rebalanceCaller: RebalanceLlmCaller = async () => JSON.stringify({
      evaluations: [{ ticker: "SZ300319", judgment: "BUY", brief: "buy" }],
      actions: [{ action: "BUY", ticker: "SZ300319", name: "麦捷科技", reason: "buy" }],
      summary: "buy",
    });

    const result = await rebalancePipeline({
      scan, holdings, lastRebalance: null, currentDate: "2026-06-21",
      shallowCaller, rebalanceCaller, dataByTicker,
    });

    expect(result.status).toBe("ok");
    const action = result.rebalancer_output.actions[0];
    expect(action.action).toBe("HOLD"); // 降级
    expect(action.target_weight).toBe(0); // 候选股 current=0
    expect(result.rebalancer_output.portfolio_after.cash_pct).toBeCloseTo(1.0, 5);
  });

  it("shallow-analyzer 数据缺失 → 候选股跳过，rebalancer 看不到", async () => {
    const scan: ScanSummary = {
      scan_date: "2026-06-21", total_candidates: 1,
      groups: { LONG: { total: 1, ranked: 1, excluded: 0, fallback: false }, SHORT: { total: 0, pre_filter: 0, post_common_filter: 0, ranked: 0, excluded: 0, fallback: false } },
      top_picks: [
        { ticker: "SZ300319", name: "麦捷科技", score: 9.5, group: "LONG", percent: 134, days: 55, range_kind: "new", reason: "r" },
      ],
    };
    const holdings: Holdings = { updated_at: "x", cash_pct: 1.0, positions: [] };

    const shallowCaller: ShallowLlmCaller = async () => JSON.stringify({ thesis: "x", fitness_score: 8, data_freshness: "2026-06-21", key_signals: [], data_gaps: [] });
    const rebalanceCaller: RebalanceLlmCaller = async () => JSON.stringify({
      evaluations: [], actions: [],
      portfolio_after: { positions: [], cash_pct: 1.0 },
      summary: "no candidates",
    });

    const result = await rebalancePipeline({
      scan, holdings, lastRebalance: null, currentDate: "2026-06-21",
      shallowCaller, rebalanceCaller,
      dataByTicker: new Map(),  // 空 → 候选股跳过
    });

    expect(result.reports).toHaveLength(0);
  });

  it("候选股 industry 填充 ctx.sectors：不同行业不触发规则 3（单行业 ≤30%）", async () => {
    // 场景：两只候选股都 BUY 16%（超单仓 15%？不，用 14% 避免触发规则 2）
    // 若都标"未分类"，单行业 sum=28% < 30% 不触发——改用更直接验证：
    // 构造 sector_warnings 为空（industry 都拉到了）
    const scan: ScanSummary = {
      scan_date: "2026-06-21", total_candidates: 2,
      groups: { LONG: { total: 2, ranked: 2, excluded: 0, fallback: false }, SHORT: { total: 0, pre_filter: 0, post_common_filter: 0, ranked: 0, excluded: 0, fallback: false } },
      top_picks: [
        { ticker: "SZ300319", name: "麦捷科技", score: 9.5, group: "LONG", percent: 134, days: 55, range_kind: "new", reason: "r" },
        { ticker: "SH600519", name: "贵州茅台", score: 9.0, group: "LONG", percent: 50, days: 30, range_kind: "new", reason: "r" },
      ],
    };
    const holdings: Holdings = { updated_at: "x", cash_pct: 0.50, positions: [] };

    // fundamentals 给不同 industry（电子 vs 白酒）+ 非零 pe/np_q1（避免质量门控钳制 fitness）
    const dataByTicker = new Map<string, StockData>([
      ["SZ300319", { ticker: "SZ300319", name: "麦捷科技", sector: "未分类", kline: { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0.01, volume_ratio_5_20: 1.0 }, news: [], hot_money: { northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" }, fundamentals: { pe: 25, pb: 3, rev_q1: 1e9, np_q1: 1e8, industry: "电子" } }],
      ["SH600519", { ticker: "SH600519", name: "贵州茅台", sector: "未分类", kline: { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0.01, volume_ratio_5_20: 1.0 }, news: [], hot_money: { northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" }, fundamentals: { pe: 30, pb: 10, rev_q1: 4e9, np_q1: 2e9, industry: "白酒" } }],
    ]);

    const shallowCaller: ShallowLlmCaller = async ({ role }) => {
      if (role === "analyst") return JSON.stringify({ thesis: "x", fitness_score: 9, data_freshness: "2026-06-21", key_signals: [], data_gaps: [] });
      return JSON.stringify({ risk_flags: [], overall_risk: "low", deal_breaker: false });
    };
    const rebalanceCaller: RebalanceLlmCaller = async () => JSON.stringify({
      evaluations: [
        { ticker: "SZ300319", judgment: "BUY", brief: "buy" },
        { ticker: "SH600519", judgment: "BUY", brief: "buy" },
      ],
      actions: [
        { action: "BUY", ticker: "SZ300319", name: "麦捷科技", reason: "buy" },
        { action: "BUY", ticker: "SH600519", name: "贵州茅台", reason: "buy" },
      ],
      summary: "buy both",
    });

    const result = await rebalancePipeline({
      scan, holdings, lastRebalance: null, currentDate: "2026-06-21",
      shallowCaller, rebalanceCaller, dataByTicker,
    });

    expect(result.status).toBe("ok");
    // industry 都拉到了 → 无 warning
    expect(result.sector_warnings).toHaveLength(0);
    // 两只都 BUY（fitness 9 + low risk + 低波动 → 7% 各），约束通过
    const actions = result.rebalancer_output.actions;
    expect(actions).toHaveLength(2);
    // 验证规则 3 没误触发：两只不同行业，sum 各 7% 远低于 30%
    expect(result.constraint_check.passed).toBe(true);
  });

  it("industry 拉取失败 → 回退'未分类' + sector_warnings 提示", async () => {
    const scan: ScanSummary = {
      scan_date: "2026-06-21", total_candidates: 1,
      groups: { LONG: { total: 1, ranked: 1, excluded: 0, fallback: false }, SHORT: { total: 0, pre_filter: 0, post_common_filter: 0, ranked: 0, excluded: 0, fallback: false } },
      top_picks: [
        { ticker: "SZ300319", name: "麦捷科技", score: 9.5, group: "LONG", percent: 134, days: 55, range_kind: "new", reason: "r" },
      ],
    };
    const holdings: Holdings = { updated_at: "x", cash_pct: 0.80, positions: [] };

    // fundamentals.industry 为空（模拟拉取失败）+ 非零 pe/np_q1（避免质量门控钳制 fitness）
    const dataByTicker = new Map<string, StockData>([
      ["SZ300319", { ticker: "SZ300319", name: "麦捷科技", sector: "未分类", kline: { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0.01, volume_ratio_5_20: 1.0 }, news: [], hot_money: { northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" }, fundamentals: { pe: 25, pb: 3, rev_q1: 1e9, np_q1: 1e8, industry: "" } }],
    ]);

    const shallowCaller: ShallowLlmCaller = async ({ role }) => {
      if (role === "analyst") return JSON.stringify({ thesis: "x", fitness_score: 9, data_freshness: "2026-06-21", key_signals: [], data_gaps: [] });
      return JSON.stringify({ risk_flags: [], overall_risk: "low", deal_breaker: false });
    };
    const rebalanceCaller: RebalanceLlmCaller = async () => JSON.stringify({
      evaluations: [{ ticker: "SZ300319", judgment: "BUY", brief: "buy" }],
      actions: [{ action: "BUY", ticker: "SZ300319", name: "麦捷科技", reason: "buy" }],
      summary: "buy",
    });

    const result = await rebalancePipeline({
      scan, holdings, lastRebalance: null, currentDate: "2026-06-21",
      shallowCaller, rebalanceCaller, dataByTicker,
    });

    expect(result.status).toBe("ok");
    // industry 拉取失败 → 应有 warning
    expect(result.sector_warnings.length).toBeGreaterThan(0);
    expect(result.sector_warnings[0]).toContain("SZ300319");
    expect(result.sector_warnings[0]).toContain("未分类");
  });

  it("持仓股 fundamentals.industry 覆盖用户填的 sector", async () => {
    // 用户 holdings 填 sector="电子"，但 fundamentals 查到 industry="元件"
    // 应以 fundamentals 为准（全市场口径统一）
    const scan: ScanSummary = {
      scan_date: "2026-06-21", total_candidates: 0,
      groups: { LONG: { total: 0, ranked: 0, excluded: 0, fallback: false }, SHORT: { total: 0, pre_filter: 0, post_common_filter: 0, ranked: 0, excluded: 0, fallback: false } },
      top_picks: [],
    };
    const holdings: Holdings = {
      updated_at: "x", cash_pct: 0.90,
      positions: [{ ticker: "SZ300319", name: "麦捷科技", weight: 0.10, entry_price: 25, entry_date: "2026-05-20", shares: 200, sector: "电子" }],
    };

    const dataByTicker = new Map<string, StockData>([
      ["SZ300319", { ticker: "SZ300319", name: "麦捷科技", sector: "电子", kline: { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0.01 }, news: [], hot_money: { northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" }, fundamentals: { pe: 0, pb: 0, rev_q1: 0, np_q1: 0, industry: "元件" } }],
    ]);

    const shallowCaller: ShallowLlmCaller = async ({ role }) => {
      if (role === "analyst") return JSON.stringify({ thesis: "x", fitness_score: 8, data_freshness: "2026-06-21", key_signals: [], data_gaps: [] });
      return JSON.stringify({ risk_flags: [], overall_risk: "low", deal_breaker: false });
    };
    const rebalanceCaller: RebalanceLlmCaller = async () => JSON.stringify({
      evaluations: [{ ticker: "SZ300319", judgment: "HOLD", brief: "hold" }],
      actions: [{ action: "HOLD", ticker: "SZ300319", name: "麦捷科技", reason: "hold" }],
      summary: "hold",
    });

    const result = await rebalancePipeline({
      scan, holdings, lastRebalance: null, currentDate: "2026-06-21",
      shallowCaller, rebalanceCaller, dataByTicker,
    });

    expect(result.status).toBe("ok");
    // industry 拉到了 → 无 warning（即使持仓股用户填的 sector 被覆盖）
    expect(result.sector_warnings).toHaveLength(0);
  });

  it("重大解禁兜底：LLM 给 fitness=9 + risk=low，但 lockup 重大压力 → overall_risk 强制 high + quality_notes 标注", async () => {
    const scan: ScanSummary = {
      scan_date: "2026-06-21", total_candidates: 1,
      groups: { LONG: { total: 1, ranked: 1, excluded: 0, fallback: false }, SHORT: { total: 0, pre_filter: 0, post_common_filter: 0, ranked: 0, excluded: 0, fallback: false } },
      top_picks: [
        { ticker: "SZ300319", name: "麦捷科技", score: 9.5, group: "LONG", percent: 134, days: 55, range_kind: "new", reason: "r" },
      ],
    };
    const holdings: Holdings = { updated_at: "x", cash_pct: 1.0, positions: [] };

    const dataByTicker = new Map<string, StockData>([
      // PE/净利 非零（趋势模式虽不钳制，但保持数据完备更清晰），lockup 重大压力
      ["SZ300319", {
        ticker: "SZ300319", name: "麦捷科技", sector: "电子",
        kline: { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0.01 },
        news: [], hot_money: { northbound_yi: 0, northbound_signal: "", sector_in_industry_tag: "" },
        fundamentals: { pe: 30, pb: 5, rev_q1: 1e9, np_q1: 1e8 },
        lockup: { pressure_rating: "重大压力", upcoming: [{ date: "2026-08-15", ratio: "8%" }], reduce_holdings: [] },
      }],
    ]);

    // LLM 漏判解禁：给 fitness=9 + risk=low（无 deal_breaker）
    const shallowCaller: ShallowLlmCaller = async ({ role }) => {
      if (role === "analyst") return JSON.stringify({ thesis: "订单饱满业绩兑现产能就绪", fitness_score: 9, data_freshness: "2026-06-21", key_signals: [], data_gaps: [] });
      return JSON.stringify({ risk_flags: [], overall_risk: "low", deal_breaker: false });
    };
    const rebalanceCaller: RebalanceLlmCaller = async () => JSON.stringify({
      evaluations: [{ ticker: "SZ300319", judgment: "BUY", brief: "buy" }],
      actions: [{ action: "BUY", ticker: "SZ300319", name: "麦捷科技", reason: "buy" }],
      summary: "buy",
    });

    const result = await rebalancePipeline({
      scan, holdings, lastRebalance: null, currentDate: "2026-06-21",
      shallowCaller, rebalanceCaller, dataByTicker,
    });

    // 质量门控规则7：解禁兜底生效——overall_risk 被强制 high
    const report = result.reports.find(r => r.ticker === "SZ300319");
    expect(report).toBeDefined();
    expect(report!.overall_risk).toBe("high");
    expect(report!.fitness_score).toBe(9);  // fitness 不动（解禁影响 risk 不影响 fitness）
    expect(report!.quality_notes).toBeDefined();
    expect(report!.quality_notes!.some(n => n.includes("解禁") || n.includes("重大压力"))).toBe(true);
    // 趋势模式：risk=high 不打折仓位（靠止损退出，不靠仓位压缩）
    // 仓位：BUY 9分 × 0.008 = 7.2% × 波动1.0 = 7.2%（risk=high 不再 ×0.3）
    const action = result.rebalancer_output.actions.find(a => a.ticker === "SZ300319");
    expect(action!.target_weight).toBeCloseTo(0.072, 2);
  });
});
