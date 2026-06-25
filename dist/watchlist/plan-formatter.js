"use strict";
// src/watchlist/plan-formatter.ts
//
// 把 RebalancePlanFile（机器格式）渲染成 plan.md（人类可读）。
// 纯函数，无副作用，便于测试。
//
// 结构：标题 + 状态摘要 → 当前持仓表 → 调仓建议表 → 仓位溯源（有操作的股）
//       → 被跳过的候选简表 → 约束检查 → 执行顺序 → LLM 总结
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatPlanMarkdown = formatPlanMarkdown;
const ACTION_LABEL = {
    BUY: "买入", SELL: "清仓", ADD: "加仓", REDUCE: "减仓", HOLD: "持有",
};
/** 主入口：把 plan.json 渲染成 markdown 字符串。 */
function formatPlanMarkdown(plan) {
    const lines = [];
    const statusIcon = plan.status === "ok" ? "✅" : plan.status === "constraint_violation" ? "⚠️" : "❌";
    const statusText = plan.status === "ok" ? "通过"
        : plan.status === "constraint_violation" ? "约束违反"
            : plan.status === "parse_failed" ? "LLM 输出格式失败"
                : "LLM 失败";
    // ── 标题 + 状态摘要 ─────────────────────────────────────────────────
    lines.push(`# 调仓方案 ${plan.scan_date}`);
    lines.push("");
    lines.push(`> ${statusIcon} status: ${statusText} | 约束: ${plan.constraint_check.passed ? "通过" : "违反"} (revise ${plan.constraint_check.revise_count}) | tokens: ${formatTokens(plan.tokens)} | model: ${plan.model}`);
    if (plan.status === "constraint_violation" && plan.constraint_check.violations.length > 0) {
        lines.push("");
        lines.push("**违反清单：**");
        for (const v of plan.constraint_check.violations)
            lines.push(`- ${v}`);
    }
    lines.push("");
    // ── 当前持仓 ───────────────────────────────────────────────────────
    lines.push("## 当前持仓");
    lines.push("");
    if (plan.holdings_before.positions.length === 0) {
        lines.push("_(无持仓，全现金)_");
    }
    else {
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
    }
    else {
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
        const reportsByTicker = new Map();
        for (const r of plan.reports)
            reportsByTicker.set(r.ticker, r);
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
        for (const w of plan.sector_warnings)
            lines.push(`- ${w}`);
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
            for (const w of plan.execution_plan.warnings)
                lines.push(`- ${w}`);
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
    // ── 数据源健康统计 ─────────────────────────────────────────────────
    if (plan.data_health) {
        lines.push(...renderDataHealth(plan.data_health));
    }
    return lines.join("\n");
}
/** 渲染单个 action 的详细溯源（thesis + 信号 + 风险）。 */
function formatActionDetail(a, report, trace) {
    const lines = [];
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
function formatTokens(tokens) {
    if (tokens >= 1000)
        return `${(tokens / 1000).toFixed(1)}K`;
    return String(tokens);
}
function computeDaysHeld(entryDate, currentDate) {
    const entry = new Date(entryDate + "T00:00:00+08:00").getTime();
    const cur = new Date(currentDate + "T00:00:00+08:00").getTime();
    if (isNaN(entry) || isNaN(cur))
        return 0;
    return Math.floor((cur - entry) / (24 * 60 * 60 * 1000));
}
function computeLocked(entryDate, currentDate, antiChurnDays = 7) {
    return computeDaysHeld(entryDate, currentDate) < antiChurnDays;
}
/** 按 sector 聚合 target_weight，返回降序排列（取 max 用于约束检查展示）。 */
function computeSectorSums(actions, reports) {
    const reportByTicker = new Map();
    for (const r of reports)
        reportByTicker.set(r.ticker, r);
    const sums = new Map();
    for (const a of actions) {
        if (a.target_weight <= 0)
            continue;
        const sector = reportByTicker.get(a.ticker)?.sector;
        if (!sector)
            continue;
        sums.set(sector, (sums.get(sector) ?? 0) + a.target_weight);
    }
    return Array.from(sums.entries())
        .map(([sector, sum]) => ({ sector, sum }))
        .sort((a, b) => b.sum - a.sum);
}
// ── 数据源健康统计渲染 ──────────────────────────────────────────────────────
function successIcon(rate) {
    if (rate >= 0.99)
        return "🟢";
    if (rate >= 0.90)
        return "🟡";
    return "🔴";
}
function rateStr(rate) {
    return `${(rate * 100).toFixed(1)}%`;
}
function durationStr(ms) {
    if (ms >= 1000)
        return `${(ms / 1000).toFixed(1)}s`;
    return `${ms}ms`;
}
function renderRollingTable(stats, label) {
    const lines = [];
    if (stats.length === 0)
        return lines;
    lines.push(`### ${label}`);
    lines.push("");
    lines.push("| 状态 | 子源 | 成功率 | 成功/失败 | 平均耗时 | 最近失败 |");
    lines.push("|------|------|--------|----------|---------|---------|");
    for (const s of stats) {
        const icon = successIcon(s.success_rate);
        const rate = rateStr(s.success_rate);
        const counts = `${s.success}/${s.failure}`;
        const dur = durationStr(s.avg_duration_ms);
        const lastErr = s.last_error ? s.last_error.slice(0, 40) : "-";
        lines.push(`| ${icon} | ${s.stage} | ${rate} | ${counts} | ${dur} | ${lastErr} |`);
    }
    lines.push("");
    return lines;
}
/** 渲染数据源健康统计段。返回 markdown 行数组。 */
function renderDataHealth(dh) {
    const lines = [];
    lines.push("## 数据源健康状态");
    lines.push("");
    // 本次 run 概览
    const totalCalls = dh.current_run.reduce((s, r) => s + r.total, 0);
    const totalFailures = dh.current_run.reduce((s, r) => s + r.failure, 0);
    const overallRate = totalCalls > 0 ? (totalCalls - totalFailures) / totalCalls : 1;
    lines.push(`> ${successIcon(overallRate)} 本次运行：${totalCalls} 次调用，${totalFailures} 次失败，总成功率 ${rateStr(overallRate)}`);
    lines.push("");
    // 本次 run 详情
    lines.push("### 本次运行");
    lines.push("");
    lines.push("| 状态 | 子源 | 成功/失败 | 平均耗时 | 最近错误 |");
    lines.push("|------|------|----------|---------|---------|");
    for (const s of dh.current_run) {
        const icon = successIcon(s.success_rate);
        const counts = s.failure > 0 ? `${s.success}/${s.failure}` : `${s.success}✓`;
        const dur = durationStr(s.avg_duration_ms);
        const lastErr = s.last_error ? s.last_error.slice(0, 50) : "-";
        lines.push(`| ${icon} | ${s.stage} | ${counts} | ${dur} | ${lastErr} |`);
    }
    lines.push("");
    // 7 天滚动
    lines.push(...renderRollingTable(dh.rolling_7d, "7 天滚动（含本次）"));
    // 30 天滚动
    lines.push(...renderRollingTable(dh.rolling_30d, "30 天滚动（含本次）"));
    return lines;
}
//# sourceMappingURL=plan-formatter.js.map