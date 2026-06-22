// src/watchlist/plan-formatter.ts
//
// 把 RebalancePlanFile（机器格式）渲染成 plan.md（人类可读）。
// 纯函数，无副作用，便于测试。
//
// 结构：标题 + 状态摘要 → 当前持仓表 → 调仓建议表 → 仓位溯源（有操作的股）
//       → 被跳过的候选简表 → 约束检查 → 执行顺序 → LLM 总结

import type { RebalancePlanFile, StockReport, Action } from "./rebalance-types";

const ACTION_LABEL: Record<string, string> = {
  BUY: "买入", SELL: "清仓", ADD: "加仓", REDUCE: "减仓", HOLD: "持有",
};

/** 主入口：把 plan.json 渲染成 markdown 字符串。 */
export function formatPlanMarkdown(plan: RebalancePlanFile): string {
  const lines: string[] = [];
  const statusIcon = plan.status === "ok" ? "✅" : plan.status === "constraint_violation" ? "⚠️" : "❌";
  const statusText = plan.status === "ok" ? "通过" : plan.status === "constraint_violation" ? "约束违反" : "LLM 失败";

  // ── 标题 + 状态摘要 ─────────────────────────────────────────────────
  lines.push(`# 调仓方案 ${plan.scan_date}`);
  lines.push("");
  lines.push(`> ${statusIcon} status: ${statusText} | 约束: ${plan.constraint_check.passed ? "通过" : "违反"} (revise ${plan.constraint_check.revise_count}) | tokens: ${formatTokens(plan.tokens)} | model: ${plan.model}`);
  if (plan.status === "constraint_violation" && plan.constraint_check.violations.length > 0) {
    lines.push("");
    lines.push("**违反清单：**");
    for (const v of plan.constraint_check.violations) lines.push(`- ${v}`);
  }
  lines.push("");

  // ── 当前持仓 ───────────────────────────────────────────────────────
  lines.push("## 当前持仓");
  lines.push("");
  if (plan.holdings_before.positions.length === 0) {
    lines.push("_(无持仓，全现金)_");
  } else {
    lines.push("| ticker | name | sector | 仓位 | 持有天数 | 锁定 |");
    lines.push("|---|---|---|---|---|---|");
    for (const p of plan.holdings_before.positions) {
      const locked = computeLocked(p.entry_date, plan.scan_date) ? "🔒 是" : "否";
      lines.push(`| ${p.ticker} | ${p.name} | ${p.sector} | ${(p.weight * 100).toFixed(1)}% | ${computeDaysHeld(p.entry_date, plan.scan_date)}天 | ${locked} |`);
    }
    lines.push(`| _(cash)_ | | | ${(plan.holdings_before.cash_pct * 100).toFixed(1)}% | | |`);
  }
  lines.push("");

  // ── 调仓建议 ───────────────────────────────────────────────────────
  lines.push("## 调仓建议");
  lines.push("");
  const actions = [...plan.rebalancer_output.actions].sort((a, b) => a.priority - b.priority);
  if (actions.length === 0) {
    lines.push("_(今日无操作)_");
  } else {
    lines.push("| 优先级 | 操作 | ticker | name | 现仓位 | 目标 | 变动 |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const a of actions) {
      const sign = a.delta > 0 ? "+" : "";
      lines.push(`| ${a.priority} | ${ACTION_LABEL[a.action] ?? a.action} ${a.action} | ${a.ticker} | ${a.name} | ${(a.current_weight * 100).toFixed(1)}% | ${(a.target_weight * 100).toFixed(1)}% | ${sign}${(a.delta * 100).toFixed(1)}% |`);
    }
  }
  lines.push("");

  // ── 仓位计算溯源（有操作的股）───────────────────────────────────────
  const actionableActions = actions.filter(a => a.action !== "HOLD" || a.reason);
  if (actionableActions.length > 0) {
    lines.push("## 仓位计算溯源");
    lines.push("");
    const reportsByTicker = new Map<string, StockReport>();
    for (const r of plan.reports) reportsByTicker.set(r.ticker, r);
    for (const a of actionableActions) {
      lines.push(...formatActionDetail(a, reportsByTicker.get(a.ticker), plan.position_traces?.[a.ticker]));
      lines.push("");
    }
  }

  // ── 被跳过的候选（简表）─────────────────────────────────────────────
  const actionTickers = new Set(actions.map(a => a.ticker));
  const skipped = plan.reports.filter(r => !actionTickers.has(r.ticker) && !r.is_held);
  if (skipped.length > 0) {
    lines.push("## 被跳过的候选");
    lines.push("");
    lines.push("| ticker | name | fitness | risk | 一句话 |");
    lines.push("|---|---|---|---|---|");
    for (const r of skipped) {
      const brief = r.thesis.length > 40 ? r.thesis.slice(0, 40) + "…" : r.thesis;
      lines.push(`| ${r.ticker} | ${r.name} | ${r.fitness_score} | ${r.overall_risk} | ${brief.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }

  // ── 约束检查 ───────────────────────────────────────────────────────
  lines.push("## 约束检查");
  lines.push("");
  const pa = plan.rebalancer_output.portfolio_after;
  const totalWeight = pa.positions.reduce((s, p) => s + p.weight, 0);
  const maxSingle = Math.max(0, ...actions.map(a => a.target_weight));
  const sectorSums = computeSectorSums(actions, plan.reports);
  const maxSector = sectorSums.length > 0 ? sectorSums[0] : null;
  const turnover = actions.reduce((s, a) => s + Math.abs(a.delta), 0);
  lines.push(`- 权重和 = 100%: ${Math.abs(totalWeight + pa.cash_pct - 1) < 0.001 ? "✓" : "✗"} (${(totalWeight * 100).toFixed(1)}% + cash ${(pa.cash_pct * 100).toFixed(1)}%)`);
  lines.push(`- 单仓 ≤15%: ${maxSingle <= 0.15 + 0.001 ? "✓" : "✗"} (max ${(maxSingle * 100).toFixed(1)}%)`);
  if (maxSector) {
    lines.push(`- 单行业 ≤30%: ${maxSector.sum <= 0.30 + 0.001 ? "✓" : "✗"} (${maxSector.sector} ${(maxSector.sum * 100).toFixed(1)}%)`);
  }
  lines.push(`- 日换手 ≤30%: ${turnover <= 0.30 + 0.001 ? "✓" : "✗"} (${(turnover * 100).toFixed(1)}%)`);
  lines.push(`- 现金 ≥10%: ${pa.cash_pct >= 0.10 - 0.001 ? "✓" : "✗"} (${(pa.cash_pct * 100).toFixed(1)}%)`);
  lines.push(`- revise 次数: ${plan.constraint_check.revise_count}`);
  if (plan.sector_warnings && plan.sector_warnings.length > 0) {
    lines.push("");
    lines.push("**⚠️ 行业警告：**");
    for (const w of plan.sector_warnings) lines.push(`- ${w}`);
  }
  lines.push("");

  // ── 执行顺序 ───────────────────────────────────────────────────────
  const seq = plan.execution_plan.execution_sequence;
  if (seq.length > 0) {
    lines.push("## 执行顺序");
    lines.push("");
    for (const s of seq) {
      const sign = s.weight_delta > 0 ? "+" : "";
      const note = s.note ? `（${s.note}）` : "";
      lines.push(`${s.step}. **${s.action} ${s.ticker} ${s.name}** ${sign}${(s.weight_delta * 100).toFixed(1)}%${note} → cash ${(s.est_cash_after * 100).toFixed(1)}%`);
    }
    if (plan.execution_plan.warnings.length > 0) {
      lines.push("");
      lines.push("**⚠️ 执行警告：**");
      for (const w of plan.execution_plan.warnings) lines.push(`- ${w}`);
    }
    lines.push("");
  }

  // ── LLM 总结 ───────────────────────────────────────────────────────
  if (plan.rebalancer_output.summary) {
    lines.push("## LLM 总结");
    lines.push("");
    lines.push(`> ${plan.rebalancer_output.summary}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** 渲染单个 action 的详细溯源（thesis + 信号 + 风险）。 */
function formatActionDetail(a: Action, report: StockReport | undefined, trace?: string): string[] {
  const lines: string[] = [];
  const header = `### ${a.ticker} ${a.name} — ${ACTION_LABEL[a.action] ?? a.action} ${(a.current_weight * 100).toFixed(1)}%→${(a.target_weight * 100).toFixed(1)}%`;
  lines.push(header);
  lines.push("");
  if (trace) {
    lines.push(`- **溯源**: ${trace}`);
  }
  if (a.reason) {
    lines.push(`- **理由**: ${a.reason}`);
  }
  if (report) {
    lines.push(`- **fitness**: ${report.fitness_score} | **risk**: ${report.overall_risk}${report.deal_breaker ? " [DEAL_BREAKER]" : ""}${report.locked ? " | 🔒 锁定" : ""}`);
    if (report.thesis) {
      lines.push(`- **thesis**: ${report.thesis}`);
    }
    if (report.key_signals.length > 0) {
      lines.push(`- **关键信号**: ${report.key_signals.join("; ")}`);
    }
    if (report.risk_flags.length > 0) {
      const flagsStr = report.risk_flags
        .map(f => `${f.flag}(${f.severity})`)
        .join("; ");
      lines.push(`- **风险**: ${flagsStr}`);
    }
    if (report.data_gaps.length > 0) {
      lines.push(`- **数据缺失**: ${report.data_gaps.join("; ")}`);
    }
  }
  return lines;
}

// ── 辅助函数 ────────────────────────────────────────────────────────────────

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}

function computeDaysHeld(entryDate: string, currentDate: string): number {
  const entry = new Date(entryDate + "T00:00:00+08:00").getTime();
  const cur = new Date(currentDate + "T00:00:00+08:00").getTime();
  if (isNaN(entry) || isNaN(cur)) return 0;
  return Math.floor((cur - entry) / (24 * 60 * 60 * 1000));
}

function computeLocked(entryDate: string, currentDate: string, antiChurnDays = 7): boolean {
  return computeDaysHeld(entryDate, currentDate) < antiChurnDays;
}

/** 按 sector 聚合 target_weight，返回降序排列（取 max 用于约束检查展示）。 */
function computeSectorSums(actions: Action[], reports: StockReport[]): Array<{ sector: string; sum: number }> {
  const reportByTicker = new Map<string, StockReport>();
  for (const r of reports) reportByTicker.set(r.ticker, r);
  const sums = new Map<string, number>();
  for (const a of actions) {
    if (a.target_weight <= 0) continue;
    const sector = reportByTicker.get(a.ticker)?.sector;
    if (!sector) continue;
    sums.set(sector, (sums.get(sector) ?? 0) + a.target_weight);
  }
  return Array.from(sums.entries())
    .map(([sector, sum]) => ({ sector, sum }))
    .sort((a, b) => b.sum - a.sum);
}
