"use strict";
// src/report-formatter.ts — Convert analysis results to readable Markdown / HTML
Object.defineProperty(exports, "__esModule", { value: true });
exports.toMarkdown = toMarkdown;
exports.toHtml = toHtml;
/**
 * Escape the five HTML-significant characters. Used on every LLM-generated
 * string before it is interpolated into HTML, so a model (or a poisoned data
 * field) emitting `<script>` / `<img onerror>` cannot execute when the report
 * is opened in a browser. Markdown structure is re-applied afterwards by
 * markdownToHtml(); for plain interpolations the caller escapes directly.
 */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
/**
 * Minimal Markdown → HTML converter for LLM-generated text.
 * Handles: headings, bold, lists, horizontal rules, paragraphs.
 *
 * Escapes HTML entities FIRST so any literal markup in the LLM output is
 * rendered as inert text rather than executed when the report opens in a
 * browser (stored-XSS defense). Markdown emphasis characters are then
 * re-applied on the escaped text.
 */
function markdownToHtml(md) {
    // Escape HTML first — subsequent markdown passes only re-introduce the
    // limited, allowlisted tags below (<hr><hN><strong><li><ul><p><br>).
    let html = escapeHtml(md);
    // Remove VERDICT HTML comments (now entity-escaped to &lt;!-- … --&gt;)
    html = html.replace(/&lt;!--[\s\S]*?--&gt;/g, "");
    // Horizontal rules
    html = html.replace(/^---\s*$/gm, "<hr>");
    // Headings (### before ## before #)
    html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
    html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^# (.+)$/gm, "<h2>$1</h2>");
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // Unordered list items
    html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
    // Ordered list items
    html = html.replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>");
    // Wrap consecutive <li> in <ul>
    html = html.replace(/((?:<li>.*<\/li>\s*)+)/g, (match) => {
        return "<ul>" + match + "</ul>";
    });
    // Paragraphs: wrap lines that aren't already wrapped in tags
    html = html
        .split("\n\n")
        .map((block) => {
        const trimmed = block.trim();
        if (!trimmed)
            return "";
        if (trimmed.startsWith("<"))
            return trimmed;
        return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
        .join("\n");
    return html;
}
/** Strip VERDICT comments and trim execution plan for clean display */
function cleanExecutionPlan(raw) {
    return raw
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/^---\s*$/gm, "")
        .trim();
}
function directionEmoji(d) {
    const lower = d.toLowerCase();
    if (["看多", "buy", "overweight", "pass"].includes(lower))
        return "🟢";
    if (["看空", "sell", "underweight", "reject"].includes(lower))
        return "🔴";
    return "🟡";
}
function directionLabel(d) {
    const map = {
        "看多": "看多 Bullish", "看空": "看空 Bearish", "中性": "中性 Neutral",
        "Buy": "买入 Buy", "Sell": "卖出 Sell", "Hold": "持有 Hold",
        "Overweight": "增持 Overweight", "Underweight": "减持 Underweight",
        "pass": "通过 Pass", "revise": "修订 Revise", "reject": "拒绝 Reject",
    };
    return map[d] || d;
}
// ── Markdown ──
function toMarkdown(result) {
    const lines = [];
    const isFull = result.mode === "full";
    const full = isFull ? result : null;
    lines.push(`# ${result.ticker} 分析报告`);
    lines.push(``);
    lines.push(`- **日期**: ${result.date}`);
    lines.push(`- **模式**: ${isFull ? "Full（完整辩论+风控）" : "Quick（快速分析）"}`);
    // Final decision
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
    lines.push(`## 最终决策: ${directionEmoji(result.final.direction)} ${directionLabel(result.final.direction)}`);
    lines.push(``);
    if (result.final.target_price > 0) {
        lines.push(`| 项目 | 值 |`);
        lines.push(`|------|-----|`);
        lines.push(`| 目标价 | **${result.final.target_price} 元** |`);
        lines.push(`| 止损价 | ${result.final.stop_loss} 元 |`);
        lines.push(`| 建议仓位 | ${result.final.position_pct}% |`);
        lines.push(`| 信心水平 | ${(result.final.confidence * 100).toFixed(0)}% |`);
        lines.push(``);
    }
    lines.push(`> ${result.final.reasoning}`);
    lines.push(``);
    if (result.final.key_risks?.length) {
        lines.push(`**关键风险**: ${result.final.key_risks.join(" / ")}`);
        lines.push(``);
    }
    // Analyst verdicts
    lines.push(`---`);
    lines.push(``);
    lines.push(`## 分析师观点`);
    lines.push(``);
    lines.push(`| 分析师 | 方向 | 理由 |`);
    lines.push(`|--------|------|------|`);
    for (const report of result.analysts) {
        const emoji = directionEmoji(report.verdict.direction);
        lines.push(`| ${report.role} | ${emoji} ${directionLabel(report.verdict.direction)} | ${report.verdict.reason} |`);
    }
    lines.push(``);
    // Debate (full mode only)
    if (full?.debate) {
        lines.push(`---`);
        lines.push(``);
        lines.push(`## 多空辩论 (${full.debate.rounds.length} 轮)`);
        lines.push(``);
        for (const round of full.debate.rounds) {
            lines.push(`### 第 ${round.round} 轮`);
            lines.push(``);
            if (round.bull_claims.length > 0) {
                lines.push(`**多头论点**:`);
                for (const c of round.bull_claims) {
                    lines.push(`- **${c.topic}** (信心 ${Math.round(c.confidence * 100)}%): ${c.evidence}`);
                }
                lines.push(``);
            }
            if (round.bear_claims.length > 0) {
                lines.push(`**空头论点**:`);
                for (const c of round.bear_claims) {
                    lines.push(`- **${c.topic}** (信心 ${Math.round(c.confidence * 100)}%): ${c.evidence}`);
                }
                lines.push(``);
            }
        }
        const bullSummaryClean = cleanExecutionPlan(full.debate.bull_summary)
            .replace(/^#{1,3}\s+.*$/gm, "").trim();
        const bearSummaryClean = cleanExecutionPlan(full.debate.bear_summary)
            .replace(/^#{1,3}\s+.*$/gm, "").trim();
        lines.push(`**多头总结**: ${bullSummaryClean}`);
        lines.push(``);
        lines.push(`**空头总结**: ${bearSummaryClean}`);
        lines.push(``);
    }
    // Research decision (full mode only)
    if (full?.research_decision) {
        const rd = full.research_decision;
        lines.push(`---`);
        lines.push(``);
        lines.push(`## 研究经理裁决`);
        lines.push(``);
        lines.push(`| 项目 | 值 |`);
        lines.push(`|------|-----|`);
        lines.push(`| 方向 | ${directionEmoji(rd.direction)} ${directionLabel(rd.direction)} |`);
        lines.push(`| 信心水平 | ${(rd.confidence * 100).toFixed(0)}% |`);
        lines.push(`| 多头得分 | ${rd.bull_score} |`);
        lines.push(`| 空头得分 | ${rd.bear_score} |`);
        lines.push(``);
        lines.push(`> ${rd.reasoning}`);
        lines.push(``);
    }
    // Trading plan (full mode only)
    if (full?.trading_plan) {
        const tp = full.trading_plan;
        lines.push(`---`);
        lines.push(``);
        lines.push(`## 交易执行计划`);
        lines.push(``);
        lines.push(`- **目标价**: ${tp.target_price} 元`);
        lines.push(`- **止损价**: ${tp.stop_loss} 元`);
        lines.push(`- **建议仓位**: ${tp.position_pct}%`);
        lines.push(``);
        lines.push(cleanExecutionPlan(tp.execution_plan));
        lines.push(``);
        if (tp.entry_signals?.length) {
            lines.push(`**入场信号（triggers）**:`);
            for (const s of tp.entry_signals)
                lines.push(`- ${s}`);
            lines.push(``);
        }
        if (tp.exit_signals?.length) {
            lines.push(`**退出信号**:`);
            for (const s of tp.exit_signals)
                lines.push(`- ${s}`);
            lines.push(``);
        }
        if (tp.invalidations?.length) {
            lines.push(`**失效条件（invalidations — 出现即推翻判断）**:`);
            for (const s of tp.invalidations)
                lines.push(`- ${s}`);
            lines.push(``);
        }
    }
    // Risk assessment (full mode only)
    if (full?.risk_assessment) {
        const ra = full.risk_assessment;
        lines.push(`---`);
        lines.push(``);
        lines.push(`## 风控评估: ${directionEmoji(ra.status)} ${directionLabel(ra.status)}`);
        lines.push(``);
        lines.push(`- **风险评分**: ${ra.risk_score}/100`);
        lines.push(`- **说明**: ${ra.reasoning}`);
        lines.push(``);
        // Structured constraints from RISK_JUDGE (when present)
        const j = ra.judge;
        if (j) {
            const constraintSection = (title, items) => {
                if (!items || items.length === 0)
                    return;
                lines.push(`**${title}**:`);
                for (const c of items)
                    lines.push(`- ${c}`);
                lines.push(``);
            };
            constraintSection("硬约束（必须遵守）", j.hard_constraints);
            constraintSection("软建议", j.soft_constraints);
            constraintSection("进场前提", j.execution_preconditions);
            constraintSection("降风险触发器", j.de_risk_triggers);
        }
    }
    lines.push(`---`);
    lines.push(``);
    lines.push(`*Generated by [OpenClaw Trading Agents](https://github.com/kangjinghang/openclaw-trading-agents)*`);
    return lines.join("\n");
}
// ── HTML ──
function toHtml(result) {
    const isFull = result.mode === "full";
    const full = isFull ? result : null;
    function dirBadge(d) {
        const lower = d.toLowerCase();
        const color = ["看多", "buy", "overweight", "pass"].includes(lower) ? "#16a34a"
            : ["看空", "sell", "underweight", "reject"].includes(lower) ? "#dc2626"
                : "#ca8a04";
        return `<span style="background:${color};color:#fff;padding:2px 10px;border-radius:12px;font-size:13px;white-space:nowrap">${directionLabel(d)}</span>`;
    }
    let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${result.ticker} 分析报告</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; color: #1a1a1a; line-height: 1.6; }
  h1 { border-bottom: 2px solid #e5e7eb; padding-bottom: 12px; }
  h2 { color: #374151; margin-top: 32px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; }
  h3 { color: #4b5563; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
  th { background: #f9fafb; font-weight: 600; }
  .verdict { font-weight: bold; }
  .section { margin: 24px 0; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 13px; }
  blockquote { border-left: 3px solid #d1d5db; padding-left: 16px; color: #4b5563; margin: 12px 0; }
  .card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 12px 0; }
</style>
</head>
<body>
<h1>${result.ticker} 分析报告</h1>
<p><strong>日期</strong>: ${result.date} &nbsp;|&nbsp; <strong>模式</strong>: ${isFull ? "Full（完整辩论+风控）" : "Quick（快速分析）"}</p>

<div class="section">
<h2>最终决策 ${dirBadge(result.final.direction)}</h2>`;
    if (result.final.target_price > 0) {
        html += `
<table>
<tr><th>项目</th><th>值</th></tr>
<tr><td>目标价</td><td><strong>${result.final.target_price} 元</strong></td></tr>
<tr><td>止损价</td><td>${result.final.stop_loss} 元</td></tr>
<tr><td>建议仓位</td><td>${result.final.position_pct}%</td></tr>
<tr><td>信心水平</td><td>${(result.final.confidence * 100).toFixed(0)}%</td></tr>
</table>`;
    }
    html += `
<blockquote>${escapeHtml(result.final.reasoning)}</blockquote>`;
    if (result.final.key_risks?.length) {
        html += `<p><strong>关键风险</strong>: ${result.final.key_risks.map(escapeHtml).join(" / ")}</p>`;
    }
    html += `
</div>

<div class="section">
<h2>分析师观点</h2>
<table>
<tr><th>分析师</th><th>方向</th><th>理由</th></tr>`;
    for (const report of result.analysts) {
        html += `
<tr><td>${escapeHtml(report.role)}</td><td class="verdict">${dirBadge(report.verdict.direction)}</td><td>${escapeHtml(report.verdict.reason)}</td></tr>`;
    }
    html += `
</table>
</div>`;
    // Debate
    if (full?.debate) {
        html += `
<div class="section">
<h2>多空辩论 (${full.debate.rounds.length} 轮)</h2>`;
        for (const round of full.debate.rounds) {
            html += `<h3>第 ${round.round} 轮</h3>`;
            html += `<div class="card"><strong>多头论点</strong>:`;
            for (const c of round.bull_claims) {
                // Escape first, then re-apply bold — so literal < > in LLM text is
                // neutralized but the allowlisted <strong> tag still renders.
                const ev = escapeHtml(c.evidence).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
                html += `<br>• <strong>${escapeHtml(c.topic)}</strong> <span style="color:#6b7280">(信心 ${Math.round(c.confidence * 100)}%)</span>: ${ev}`;
            }
            html += `</div>`;
            html += `<div class="card"><strong>空头论点</strong>:`;
            for (const c of round.bear_claims) {
                const ev = escapeHtml(c.evidence).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
                html += `<br>• <strong>${escapeHtml(c.topic)}</strong> <span style="color:#6b7280">(信心 ${Math.round(c.confidence * 100)}%)</span>: ${ev}`;
            }
            html += `</div>`;
        }
        // Escape before each markdown pass: the comment-strip regex runs on the
        // escaped string (&lt;!--), and the bold converter only re-introduces the
        // allowlisted <strong> tag.
        const cleanSummary = (s) => escapeHtml(s)
            .replace(/&lt;!--[\s\S]*?--&gt;/g, "")
            .replace(/^#{1,3}\s+.*$/gm, "")
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/\n+/g, "<br>")
            .trim();
        const bullClean = cleanSummary(full.debate.bull_summary);
        const bearClean = cleanSummary(full.debate.bear_summary);
        html += `
<blockquote><strong>多头总结</strong>: ${bullClean}<br><strong>空头总结</strong>: ${bearClean}</blockquote>
</div>`;
    }
    // Research
    if (full?.research_decision) {
        const rd = full.research_decision;
        html += `
<div class="section">
<h2>研究经理裁决 ${dirBadge(rd.direction)}</h2>
<table>
<tr><th>项目</th><th>值</th></tr>
<tr><td>方向</td><td>${directionLabel(rd.direction)}</td></tr>
<tr><td>信心水平</td><td>${(rd.confidence * 100).toFixed(0)}%</td></tr>
<tr><td>多头得分</td><td>${rd.bull_score}</td></tr>
<tr><td>空头得分</td><td>${rd.bear_score}</td></tr>
</table>
<blockquote>${escapeHtml(rd.reasoning)}</blockquote>
</div>`;
    }
    // Trading plan
    if (full?.trading_plan) {
        const tp = full.trading_plan;
        html += `
<div class="section">
<h2>交易执行计划</h2>
<div class="card">
<p>目标价: <strong>${tp.target_price} 元</strong> | 止损: ${tp.stop_loss} 元 | 仓位: ${tp.position_pct}%</p>
${markdownToHtml(cleanExecutionPlan(tp.execution_plan))}
</div>
</div>`;
    }
    // Risk
    if (full?.risk_assessment) {
        const ra = full.risk_assessment;
        html += `
<div class="section">
<h2>风控评估 ${dirBadge(ra.status)}</h2>
<div class="card">
<p>风险评分: <strong>${ra.risk_score}/100</strong></p>
<p>${escapeHtml(ra.reasoning)}</p>`;
        const j = ra.judge;
        if (j) {
            const constraintHtml = (title, items) => {
                if (!items || items.length === 0)
                    return "";
                const lis = items.map((c) => `<li>${escapeHtml(c)}</li>`).join("");
                return `<p><strong>${escapeHtml(title)}</strong></p><ul>${lis}</ul>`;
            };
            html += constraintHtml("硬约束（必须遵守）", j.hard_constraints);
            html += constraintHtml("软建议", j.soft_constraints);
            html += constraintHtml("进场前提", j.execution_preconditions);
            html += constraintHtml("降风险触发器", j.de_risk_triggers);
        }
        html += `
</div>
</div>`;
    }
    html += `
<div class="footer">
Generated by <a href="https://github.com/kangjinghang/openclaw-trading-agents">OpenClaw Trading Agents</a>
</div>
</body>
</html>`;
    return html;
}
//# sourceMappingURL=report-formatter.js.map