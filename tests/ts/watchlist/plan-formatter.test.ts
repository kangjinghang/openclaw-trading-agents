import { describe, it, expect } from "vitest";
import { formatPlanMarkdown } from "../../../src/watchlist/plan-formatter";
import type { RebalancePlanFile, StockReport, Action } from "../../../src/watchlist/rebalance-types";

function makeReport(over: Partial<StockReport> = {}): StockReport {
  return {
    ticker: "SZ300319", name: "麦捷科技", sector: "电子",
    thesis: "TLVR 电感已批量供货英伟达", fitness_score: 8, key_signals: ["订单排至2027"], data_gaps: [],
    risk_flags: [{ flag: "估值偏高", severity: "中", detail: "PE 50 偏高" }], overall_risk: "medium", deal_breaker: false,
    is_held: false, current_weight: 0, days_held: 0, locked: false,
    ...over,
  };
}

function makeAction(over: Partial<Action> = {}): Action {
  const action = over.action ?? "BUY";
  const current = over.current_weight ?? 0;
  const target = over.target_weight ?? 0.05;
  return {
    action, ticker: "SZ300319", name: "麦捷科技",
    current_weight: current, target_weight: target,
    delta: target - current, reason: "订单放量", priority: 3,
    ...over,
  };
}

function makePlanFile(over: Partial<RebalancePlanFile> = {}): RebalancePlanFile {
  return {
    scan_date: "2026-06-18",
    written_at: "2026-06-22T00:00:00Z",
    status: "ok",
    model: "glm-4.7",
    tokens: 59000,
    holdings_before: {
      updated_at: "x", cash_pct: 0.80,
      positions: [{ ticker: "SH600183", name: "生益科技", weight: 0.10, entry_price: 30, entry_date: "2026-06-10", shares: 100, sector: "PCB" }],
    },
    candidates: [{ ticker: "SZ300319", ranker_score: 9.2 }],
    last_rebalance: null,
    reports: [makeReport()],
    rebalancer_output: {
      evaluations: [{ ticker: "SZ300319", judgment: "BUY", brief: "buy" }],
      actions: [makeAction()],
      portfolio_after: { positions: [{ ticker: "SZ300319", weight: 0.05 }, { ticker: "SH600183", weight: 0.10 }], cash_pct: 0.85 },
      summary: "买入麦捷科技",
    },
    constraint_check: { passed: true, violations: [], revise_count: 0 },
    execution_plan: {
      execution_sequence: [{ step: 1, action: "BUY", ticker: "SZ300319", name: "麦捷科技", weight_delta: 0.05, est_cash_after: 0.85, note: "使用资金" }],
      final_state: { positions: [{ ticker: "SZ300319", weight: 0.05 }], cash_pct: 0.85 },
      warnings: [],
    },
    position_traces: { SZ300319: "BUY：8分基础 5.0% × 波动率1.0(1.5%) × 风险0.6(medium) = 3.00%" },
    ...over,
  };
}

describe("formatPlanMarkdown", () => {
  it("包含标题 + 状态摘要", () => {
    const md = formatPlanMarkdown(makePlanFile());
    expect(md).toContain("# 调仓方案 2026-06-18");
    expect(md).toContain("status: 通过");
    expect(md).toContain("59.0K");
    expect(md).toContain("glm-4.7");
  });

  it("渲染当前持仓表（含 cash 行）", () => {
    const md = formatPlanMarkdown(makePlanFile());
    expect(md).toContain("## 当前持仓");
    expect(md).toContain("SH600183");
    expect(md).toContain("生益科技");
    expect(md).toContain("PCB");
    expect(md).toContain("10.0%");
    expect(md).toContain("80.0%"); // cash
  });

  it("渲染调仓建议表（按 priority 排序）", () => {
    const md = formatPlanMarkdown(makePlanFile({
      rebalancer_output: {
        evaluations: [],
        actions: [
          makeAction({ ticker: "A", action: "BUY", priority: 3, target_weight: 0.05 }),
          makeAction({ ticker: "B", action: "SELL", priority: 1, target_weight: 0, current_weight: 0.10 }),
        ],
        portfolio_after: { positions: [], cash_pct: 1.0 },
        summary: "",
      },
    }));
    expect(md).toContain("## 调仓建议");
    // SELL (priority 1) 应该在 BUY (priority 3) 前面
    const sellIdx = md.indexOf("SELL");
    const buyIdx = md.indexOf("BUY");
    expect(sellIdx).toBeGreaterThan(0);
    expect(buyIdx).toBeGreaterThan(0);
    expect(sellIdx).toBeLessThan(buyIdx);
  });

  it("渲染仓位溯源（有操作的股，含 trace + thesis + 信号 + 风险）", () => {
    const md = formatPlanMarkdown(makePlanFile());
    expect(md).toContain("## 仓位计算溯源");
    expect(md).toContain("SZ300319 麦捷科技");
    expect(md).toContain("**溯源**");
    expect(md).toContain("8分基础 5.0%");
    expect(md).toContain("**thesis**");
    expect(md).toContain("TLVR 电感已批量供货英伟达");
    expect(md).toContain("**关键信号**");
    expect(md).toContain("订单排至2027");
    expect(md).toContain("**风险**");
    expect(md).toContain("估值偏高");
  });

  it("渲染被跳过的候选简表", () => {
    const md = formatPlanMarkdown(makePlanFile({
      reports: [
        makeReport({ ticker: "SZ300319" }),  // 有 action
        makeReport({ ticker: "SZ999999", name: "跳过股", fitness_score: 3, overall_risk: "high", thesis: "概念早期未验证" }),
      ],
    }));
    expect(md).toContain("## 被跳过的候选");
    expect(md).toContain("SZ999999");
    expect(md).toContain("跳过股");
  });

  it("渲染约束检查（无 constraints → 按默认配置 + 标注回退）", () => {
    const md = formatPlanMarkdown(makePlanFile({ sector_warnings: ["2 只股 industry 拉取失败"] }));
    expect(md).toContain("## 约束检查");
    expect(md).toContain("权重和 = 100%");
    // 默认配置阈值（rebalance-types.ts DEFAULT_REBALANCE_CONFIG），非旧硬编码 15/30/30/10
    expect(md).toContain("单仓 ≤22%");
    expect(md).toContain("单行业 ≤25%");
    expect(md).toContain("日换手 ≤50%");
    expect(md).toContain("现金 ≥3%");
    // 换手率用单向算法 max(买,卖)，与 constraint-validator 规则 4 对齐
    expect(md).toContain("单向 max(买");
    // 无 constraints 时应有回退标注
    expect(md).toContain("按默认配置对比");
    expect(md).toContain("revise 次数: 0");
    expect(md).toContain("行业警告");
    expect(md).toContain("2 只股 industry 拉取失败");
  });

  it("渲染约束检查（带 constraints → 按真实生效阈值对比）", () => {
    const md = formatPlanMarkdown(makePlanFile({
      constraints: {
        single_name: 0.30, single_sector: 0.40, daily_turnover: 0.60,
        cash_reserve: 0.05, initial_stop_drawdown: 0.07, initial_stop_days: 3,
        max_positions: 5, take_profit_threshold: 0.15,
      },
    }));
    expect(md).toContain("单仓 ≤30%");
    expect(md).toContain("单行业 ≤40%");
    expect(md).toContain("日换手 ≤60%");
    expect(md).toContain("现金 ≥5%");
    // 有 constraints 时不该出现回退标注
    expect(md).not.toContain("按默认配置对比");
  });

  it("渲染执行顺序（含 cash 累计）", () => {
    const md = formatPlanMarkdown(makePlanFile());
    expect(md).toContain("## 执行顺序");
    expect(md).toContain("BUY SZ300319");
    expect(md).toContain("cash 85.0%");
  });

  it("渲染 LLM 总结", () => {
    const md = formatPlanMarkdown(makePlanFile());
    expect(md).toContain("## LLM 总结");
    expect(md).toContain("买入麦捷科技");
  });

  it("status=constraint_violation 显示违反清单", () => {
    const md = formatPlanMarkdown(makePlanFile({
      status: "constraint_violation",
      constraint_check: { passed: false, violations: ["[2. 单仓上限] SZ300319 0.18 超 0.15"], revise_count: 2 },
    }));
    expect(md).toContain("⚠️");
    expect(md).toContain("约束违反");
    expect(md).toContain("违反清单");
    expect(md).toContain("单仓上限");
    expect(md).toContain("revise 次数: 2");
  });

  it("status=parse_failed 显示格式失败（区别于 LLM 失败）", () => {
    const md = formatPlanMarkdown(makePlanFile({
      status: "parse_failed",
    }));
    expect(md).toContain("❌");
    expect(md).toContain("LLM 输出格式失败");
  });

  it("空 actions 显示'今日无操作'", () => {
    const md = formatPlanMarkdown(makePlanFile({
      rebalancer_output: {
        evaluations: [], actions: [],
        portfolio_after: { positions: [], cash_pct: 1.0 }, summary: "今日无机会",
      },
    }));
    expect(md).toContain("今日无操作");
  });

  it("无 position_traces（老 plan.json）溯源段显示但不崩", () => {
    const planFile = makePlanFile();
    delete planFile.position_traces;
    const md = formatPlanMarkdown(planFile);
    // 溯源段落仍渲染（thesis/信号/风险），只是没有"溯源"行
    expect(md).toContain("**thesis**");
    expect(md).not.toContain("**溯源**");
  });

  it("deal_breaker 标注 [DEAL_BREAKER]", () => {
    const md = formatPlanMarkdown(makePlanFile({
      reports: [makeReport({ deal_breaker: true, overall_risk: "high" })],
    }));
    expect(md).toContain("[DEAL_BREAKER]");
  });

  it("locked 持仓标注 🔒", () => {
    const md = formatPlanMarkdown(makePlanFile({
      reports: [makeReport({ is_held: true, locked: true, days_held: 3, current_weight: 0.10 })],
    }));
    expect(md).toContain("🔒");
  });
});
