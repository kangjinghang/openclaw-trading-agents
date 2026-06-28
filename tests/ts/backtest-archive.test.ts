// 回测调仓决策归档（archiveDayRebalance）+ 查看（renderDayRebalance）的渲染契约测试。
//
// 动机：调仓的"为什么"（evaluations / reason / summary）原本只活在 os.tmpdir 的 LLM
// trace 里，重启即清空，根本回溯不了。现在 runSingleDay 会把每天的完整决策落盘到
// days/<date>/rebalance.json，并用 --day 渲染。这里锁定渲染输出契约，防止回归。

import { describe, it, expect } from "vitest";
import {
  renderDayRebalance,
  archiveDayRebalance,
  type DayRebalanceArchive,
} from "../../src/backtest-cli";
import type {
  Holdings,
  RebalancePlan,
} from "../../src/watchlist/rebalance-types";
import type { RebalancePipelineResult } from "../../src/watchlist/rebalancer";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const plan: RebalancePlan = {
  evaluations: [
    { ticker: "SH603019", judgment: "BUY", brief: "E级超算登顶TOP500，量价齐升" },
    { ticker: "SH603986", judgment: "SKIP", brief: "同属半导体，受单行业上限约束排除" },
  ],
  actions: [
    {
      action: "BUY", ticker: "SH603019", name: "中科曙光",
      current_weight: 0, target_weight: 0.045, delta: 0.045,
      reason: "自研E级超算灵晟实测2.198EFLOPS登顶TOP500，fitness=9强标的优先集中买入",
      priority: 3,
    },
  ],
  portfolio_after: { positions: [{ ticker: "SH603019", weight: 0.045 }], cash_pct: 0.955 },
  summary: "仅新增买入fitness=9的中科曙光，持仓股受行业上限和锁定规则约束全部HOLD",
};

describe("renderDayRebalance", () => {
  it("渲染 ok 日：含状态标记、调仓前持仓、评估表、动作理由、组合总结", () => {
    const archive: DayRebalanceArchive = {
      date: "2026-06-25",
      written_at: "2026-06-27T19:34:09.000Z",
      status: "ok",
      portfolio_before: {
        cash_pct: 0.53,
        positions: [
          { ticker: "SH600176", name: "中国巨石", sector: "玻璃玻纤", weight: 0.10, entry_price: 58.93, entry_date: "2026-06-23" },
        ],
      },
      rebalancer_output: plan,
      constraint_check: { revise_count: 1, violations: ["单行业 ≤25%：半导体 30%"] },
    };

    const out = renderDayRebalance(archive);

    // 状态标记
    expect(out).toContain("✅ ok");
    expect(out).toContain("2026-06-25 调仓决策");
    // 调仓前持仓
    expect(out).toContain("调仓前：现金 53%");
    expect(out).toContain("中国巨石（SH600176）");
    // 评估表
    expect(out).toContain("✓BUY   SH603019");
    expect(out).toContain("SKIP  SH603986");
    // 动作 + 理由
    expect(out).toContain("✓ BUY 中科曙光（SH603019）");
    expect(out).toContain("理由：自研E级超算");
    // 目标权重
    expect(out).toContain("→ 4.5%");
    // 组合总结
    expect(out).toContain("仅新增买入fitness=9的中科曙光");
    // 约束博弈（revise）
    expect(out).toContain("约束博弈（revise 1 次）");
    expect(out).toContain("单行业 ≤25%");
  });

  it("渲染全 HOLD 日：标注无调仓", () => {
    const archive: DayRebalanceArchive = {
      date: "2026-06-24",
      status: "ok",
      rebalancer_output: { evaluations: [], actions: [], summary: "全部锁定持有" },
    };
    const out = renderDayRebalance(archive);
    expect(out).toContain("（全 HOLD，无调仓）");
  });

  it("渲染失败日（constraint_violation）：标 ⚠️ 让用户知道那天没调成仓", () => {
    const archive: DayRebalanceArchive = {
      date: "2026-06-24",
      status: "constraint_violation",
      rebalancer_output: undefined,
    };
    const out = renderDayRebalance(archive);
    expect(out).toContain("⚠️");
    expect(out).toContain("constraint_violation");
    expect(out).toContain("（无 rebalancer 输出）");
  });

  it("SELL/REDUCE 动作显示 ✗，BUY/ADD 显示 ✓", () => {
    const archive: DayRebalanceArchive = {
      date: "2026-06-26",
      status: "ok",
      rebalancer_output: {
        actions: [
          { action: "SELL", ticker: "SZ300196", name: "长海股份", current_weight: 0.05, target_weight: 0, delta: -0.05, reason: "见顶止损", priority: 1 },
          { action: "REDUCE", ticker: "SZ300285", name: "国瓷材料", current_weight: 0.15, target_weight: 0.10, delta: -0.05, reason: "压降集中度", priority: 2 },
        ],
        summary: "换仓",
      },
    };
    const out = renderDayRebalance(archive);
    const sellLine = out.split("\n").find(l => l.includes("SELL 长海股份"));
    const reduceLine = out.split("\n").find(l => l.includes("REDUCE 国瓷材料"));
    expect(sellLine).toBeDefined();
    expect(reduceLine).toBeDefined();
    expect(sellLine!).toContain("✗");
    expect(reduceLine!).toContain("✗");
  });
});

describe("archiveDayRebalance", () => {
  it("把完整决策（evaluations/actions/reports/constraint）写入 days/<date>/rebalance.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bt-archive-"));
    try {
      const holdings: Holdings = {
        updated_at: "2026-06-25",
        cash_pct: 0.8,
        positions: [
          { ticker: "SZ300285", name: "国瓷材料", sector: "电子化学品Ⅱ", weight: 0.20, entry_price: 89.53, entry_date: "2026-06-18", shares: 0.001 },
        ],
      };
      const result = {
        status: "ok",
        rebalancer_output: plan,
        constraint_check: { passed: true, violations: [] as string[], revise_count: 0 },
        reports: [{ ticker: "SH603019", name: "中科曙光", sector: "计算机设备", fitness_score: 9, overall_risk: "low" as const, deal_breaker: false, is_held: false, thesis: "E级超算", key_signals: [], risk_flags: [] }],
        position_traces: {},
        sector_warnings: [],
      } as unknown as RebalancePipelineResult;

      archiveDayRebalance(tmp, "2026-06-25", holdings, result);

      const file = path.join(tmp, "days", "2026-06-25", "rebalance.json");
      expect(fs.existsSync(file)).toBe(true);
      const written = JSON.parse(fs.readFileSync(file, "utf-8"));

      // 归档完整性：reason/evaluations/summary/reports 都在（这正是修复前丢失的东西）
      expect(written.date).toBe("2026-06-25");
      expect(written.status).toBe("ok");
      expect(written.rebalancer_output.evaluations).toHaveLength(2);
      expect(written.rebalancer_output.actions[0].reason).toContain("TOP500");
      expect(written.rebalancer_output.summary).toContain("中科曙光");
      // portfolio_before：持仓快照带 entry_price/entry_date（调仓时点上下文）
      expect(written.portfolio_before.cash_pct).toBe(0.8);
      expect(written.portfolio_before.positions[0].entry_date).toBe("2026-06-18");
      // reports digest：留 fitness/risk/thesis（reason 的依据）
      expect(written.reports[0].fitness_score).toBe(9);
      expect(written.reports[0].thesis).toBe("E级超算");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
