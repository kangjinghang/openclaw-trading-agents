"use strict";
// src/watchlist/data-trace-report.ts
//
// 单股数据管道调试视图（HTML）：从 API 请求 → 数据处理 → LLM prompt → LLM 响应 → 下游决策。
// 输出 data-trace.html，浏览器打开即可审查。
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateDataTraceReport = generateDataTraceReport;
const shallow_analyzer_1 = require("./shallow-analyzer");
// ── HTML 工具 ────────────────────────────────────────────────────────────────
function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fieldRow(label, value, unit = "") {
    if (value === undefined || value === null || value === "")
        return `<tr><td>${esc(label)}</td><td class="muted">缺失</td></tr>`;
    const display = typeof value === "number"
        ? (Number.isFinite(value) ? String(value) : "NaN")
        : String(value);
    return `<tr><td>${esc(label)}</td><td>${esc(display)}${esc(unit)}</td></tr>`;
}
function callRow(c) {
    const ok = c.success;
    const dur = c.duration_ms != null ? `${c.duration_ms}ms` : "-";
    const statusClass = ok ? "ok" : "fail";
    const icon = ok ? "&#10003;" : "&#10007;";
    let detailHtml = `<span class="tag ${statusClass}">${icon} ${esc(c.stage)}</span> <span class="dur">${dur}</span>`;
    if (!ok && c.error)
        detailHtml += `<span class="err">${esc(c.error.slice(0, 80))}</span>`;
    return detailHtml;
}
function summaryTable(title, rows) {
    if (rows.length === 0)
        return "";
    let h = `<div class="summary-block"><h4>${title}</h4><table>`;
    for (const [k, v] of rows)
        h += `<tr><td class="lbl">${esc(k)}</td><td>${esc(v)}</td></tr>`;
    h += "</table></div>";
    return h;
}
function detailTable(rows) {
    if (rows.length === 0)
        return "";
    let h = "<table>";
    for (const [k, v] of rows)
        h += `<tr><td class="lbl">${esc(k)}</td><td>${esc(v)}</td></tr>`;
    h += "</table>";
    return h;
}
function codeBlock(content, lang = "") {
    return `<pre><code class="${lang}">${esc(content)}</code></pre>`;
}
function details(summary, content) {
    return `<details><summary>${summary}</summary><div class="detail-body">${content}</details>`;
}
// ── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
<style>
:root {
  --bg: #0f1117; --card: #1a1d27; --border: #2a2d3a;
  --text: #e0e0e0; --muted: #888; --accent: #4fc3f7;
  --ok: #4caf50; --fail: #ef5350; --warn: #ffa726;
  --code-bg: #12141c; --hover: #252836;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, 'SF Pro Text', 'Helvetica Neue', monospace; background: var(--bg); color: var(--text); line-height: 1.6; padding: 24px; max-width: 1100px; margin: 0 auto; }
h1 { font-size: 1.4em; color: var(--accent); margin-bottom: 4px; }
h2 { font-size: 1.15em; color: var(--accent); margin: 28px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
h3 { font-size: 1.0em; color: #ccc; margin: 18px 0 8px; }
h4 { font-size: 0.9em; color: var(--muted); margin: 10px 0 6px; }
.subtitle { color: var(--muted); font-size: 0.85em; margin-bottom: 20px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin: 12px 0; }
.tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.82em; font-weight: 600; }
.tag.ok { background: #1b3a1b; color: var(--ok); }
.tag.fail { background: #3a1b1b; color: var(--fail); }
.tag.warn { background: #3a2f1b; color: var(--warn); }
.dur { color: var(--muted); font-size: 0.82em; margin-left: 6px; }
.err { color: var(--fail); font-size: 0.8em; margin-left: 8px; }
table { width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 0.88em; }
td { padding: 4px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
td.lbl { color: var(--muted); white-space: nowrap; width: 160px; }
.muted { color: var(--muted); }
pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 0.82em; line-height: 1.5; margin: 8px 0; }
code { font-family: 'SF Mono', 'Fira Code', monospace; }
.summary-block { margin: 8px 0; }
details { margin: 8px 0; }
details > summary { cursor: pointer; color: var(--accent); font-size: 0.9em; padding: 6px 0; user-select: none; }
details > summary:hover { text-decoration: underline; }
.detail-body { padding: 8px 0 8px 16px; border-left: 2px solid var(--border); }
.call-flow { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.section-divider { border: none; border-top: 1px solid var(--border); margin: 28px 0; }
.json-key { color: #9cdcfe; }
.json-str { color: #ce9178; }
.json-num { color: #b5cea8; }
.json-bool { color: #569cd6; }
.risk-flag { background: #3a1b1b; border-left: 3px solid var(--fail); padding: 6px 10px; margin: 4px 0; border-radius: 0 4px 4px 0; font-size: 0.88em; }
.risk-flag .sev { color: var(--fail); font-weight: 600; }
.action-sell { color: var(--fail); font-weight: 600; }
.action-hold { color: var(--warn); font-weight: 600; }
.action-buy { color: var(--ok); font-weight: 600; }
</style>`;
// ── 6 个数据源的链路追踪 ────────────────────────────────────────────────────
function traceKline(d) {
    let h = `<h3>1. K 线（kline.py）</h3>`;
    h += `<p class="muted">脚本: skills/trading-kline/scripts/kline.py &nbsp;|&nbsp; API: mootdx TDX TCP → akshare fallback</p>`;
    const r2 = (v) => Number.isFinite(v) ? v.toFixed(2) : String(v);
    h += summaryTable("parseKline() 处理后", [
        ["pct_5d", `${r2(d.kline.pct_5d)}%`],
        ["pct_20d", `${r2(d.kline.pct_20d)}%`],
        ["support", r2(d.kline.support)],
        ["resistance", r2(d.kline.resistance)],
        ["volatility_20d", `${r2(d.kline.volatility_20d)}%`],
        ["volume_ratio_5_20", r2(d.kline.volume_ratio_5_20)],
    ]);
    if (d.macd) {
        h += summaryTable("MACD", [
            ["DIF", String(d.macd.dif)],
            ["DEA", String(d.macd.dea)],
            ["histogram", String(d.macd.histogram)],
            ["direction", d.macd.direction],
            ["crossover", d.macd.crossover],
        ]);
    }
    h += `<h4>注入 prompt</h4>`;
    h += codeBlock(`## K 线（5 日 ${d.kline.pct_5d > 0 ? "+" : ""}${d.kline.pct_5d}% / 20 日 ${d.kline.pct_20d > 0 ? "+" : ""}${d.kline.pct_20d}%，支撑 ${d.kline.support} / 压力 ${d.kline.resistance}）`);
    return h;
}
function traceNews(d) {
    let h = `<h3>2. 新闻（news.py）</h3>`;
    h += `<p class="muted">脚本: skills/trading-news/scripts/news.py &nbsp;|&nbsp; API: 东方财富搜索</p>`;
    h += `<h4>parseNews() 处理后</h4>`;
    h += "<ul>";
    for (const n of d.news.slice(0, 5)) {
        h += `<li><strong>${esc(n.title)}</strong>`;
        if (n.content) {
            // 过滤纯数字/表格噪音，只保留可读文本段
            const clean = n.content
                .replace(/\d+\.\d+\s+\d+\.\d+/g, "") // 连续数字对
                .replace(/\b\d{6}\b/g, "") // 6位股票代码
                .replace(/\s{3,}/g, " ") // 多空格
                .trim();
            if (clean.length > 10) {
                h += `<br><span class="muted">${esc(clean.slice(0, 120))}${clean.length > 120 ? "..." : ""}</span>`;
            }
            else {
                h += `<br><span class="muted">(表格数据，省略)</span>`;
            }
        }
        if (n.time)
            h += `<br><span class="muted">${esc(n.time)}</span>`;
        h += "</li>";
    }
    if (d.news.length > 5)
        h += `<li class="muted">... 共 ${d.news.length} 条</li>`;
    h += "</ul>";
    h += `<h4>注入 prompt</h4><pre><code>`;
    for (const n of d.news) {
        const t = n.time ? `[${n.time}] ` : "";
        const c = n.content ? `：${n.content}` : "";
        h += esc(`- ${t}${n.title}${c}`) + "\n";
    }
    h += "</code></pre>";
    return h;
}
function traceHotMoney(d) {
    let h = `<h3>3. 资金流向（hot_money.py）</h3>`;
    h += `<p class="muted">脚本: skills/trading-hot-money/scripts/hot_money.py &nbsp;|&nbsp; 5 个子源并行</p>`;
    const rYi = (v) => v !== 0 ? `${(v / 1e8).toFixed(2)}亿` : "0";
    h += summaryTable("parseHotMoney() 处理后", [
        ["main_net_today", rYi(d.hot_money.main_net_today)],
        ["super_net_today", rYi(d.hot_money.super_net_today)],
        ["large_net_today", rYi(d.hot_money.large_net_today)],
        ["northbound_yi", `${d.hot_money.northbound_yi.toFixed(2)}亿`],
        ["northbound_signal", d.hot_money.northbound_signal],
        ["dragon_tiger_recent", d.hot_money.dragon_tiger_recent ?? "缺失"],
        ["sector_in_industry_tag", d.hot_money.sector_in_industry_tag ?? "缺失"],
        ["hot_stocks_top", d.hot_money.hot_stocks_top ?? "缺失"],
    ]);
    h += `<h4>注入 prompt</h4>`;
    h += codeBlock((0, shallow_analyzer_1.renderHotMoneySummary)(d.hot_money));
    return h;
}
function traceFundamentals(d) {
    let h = `<h3>4. 基本面（fundamentals.py）</h3>`;
    h += `<p class="muted">脚本: skills/trading-fundamentals/scripts/fundamentals.py &nbsp;|&nbsp; 10 个子源</p>`;
    const rYi = (v) => v > 0 ? `${(v / 1e8).toFixed(2)}亿` : String(v);
    h += summaryTable("parseFundamentals() 处理后", [
        ["pe", String(d.fundamentals.pe)],
        ["pb", String(d.fundamentals.pb)],
        ["rev_q1", rYi(d.fundamentals.rev_q1)],
        ["np_q1", rYi(d.fundamentals.np_q1)],
        ["industry", d.fundamentals.industry || "缺失"],
        ["pe_percentile", d.fundamentals.pe_percentile != null ? `${d.fundamentals.pe_percentile}%` : "缺失"],
        ["pb_percentile", d.fundamentals.pb_percentile != null ? `${d.fundamentals.pb_percentile}%` : "缺失"],
    ]);
    if (d.fundamentals.quarterly_trends && d.fundamentals.quarterly_trends.length > 0) {
        h += `<h4>季度趋势</h4>`;
        h += codeBlock((0, shallow_analyzer_1.renderQuarterlyTrends)(d.fundamentals.quarterly_trends));
    }
    if (d.fundamentals.consensus_eps) {
        h += `<h4>机构预期</h4>`;
        h += codeBlock((0, shallow_analyzer_1.renderConsensus)(d.fundamentals.consensus_eps));
    }
    h += `<h4>注入 prompt</h4>`;
    h += codeBlock(`## 基本面（PE ${d.fundamentals.pe} / PB ${d.fundamentals.pb} / Q1 营收 ${d.fundamentals.rev_q1} / Q1 净利 ${d.fundamentals.np_q1}）`);
    return h;
}
function traceVpaMacd(d) {
    let h = `<h3>5. VPA 量价预计算 + MACD</h3>`;
    h += `<p class="muted">来源: skills/trading-kline/scripts/kline.py（与 K 线同一脚本）</p>`;
    if (d.vpa_text) {
        h += `<h4>VPA 量价预计算 → 注入 risk prompt</h4>`;
        h += codeBlock(d.vpa_text);
    }
    else {
        h += `<p class="muted">VPA: 无数据</p>`;
    }
    if (d.macd) {
        h += `<h4>MACD 动量信号 → 注入 risk prompt</h4>`;
        h += codeBlock((0, shallow_analyzer_1.renderMacd)(d.macd));
    }
    return h;
}
function traceLockup(d) {
    let h = `<h3>6. 解禁与减持（lockup.py）</h3>`;
    h += `<p class="muted">脚本: skills/trading-lockup/scripts/lockup.py &nbsp;|&nbsp; 3 个子源</p>`;
    if (d.lockup) {
        h += summaryTable("parseLockup() 处理后", [
            ["pressure_rating", d.lockup.pressure_rating],
            ["upcoming 解禁数", `${d.lockup.upcoming.length}笔`],
            ["reduce_holdings 减持数", `${d.lockup.reduce_holdings.length}笔`],
        ]);
        if (d.lockup.upcoming.length > 0) {
            h += "<h4>解禁明细（未来 90 天）</h4><ul>";
            for (const u of d.lockup.upcoming.slice(0, 5)) {
                h += `<li>${esc(u.date)} | ${esc(u.type ?? "?")} | 比例 ${esc(u.ratio ?? "?")}</li>`;
            }
            h += "</ul>";
        }
        h += `<h4>注入 prompt</h4>`;
        h += codeBlock((0, shallow_analyzer_1.renderLockup)(d.lockup));
    }
    else {
        h += `<p class="muted">无解禁减持数据</p>`;
    }
    return h;
}
function traceDecisionChain(stockReport, action, positionTrace) {
    let h = `<h3>8. 下游决策链</h3>`;
    h += summaryTable("Analyst 输出 → fitness 评分", [
        ["fitness_score", String(stockReport.fitness_score)],
        ["overall_risk", stockReport.overall_risk],
        ["deal_breaker", String(stockReport.deal_breaker)],
    ]);
    if (stockReport.quality_notes && stockReport.quality_notes.length > 0) {
        h += `<p><strong>quality_notes:</strong> ${esc(stockReport.quality_notes.join("; "))}</p>`;
    }
    if (stockReport.risk_flags.length > 0) {
        h += "<h4>Risk flags</h4>";
        for (const f of stockReport.risk_flags) {
            h += `<div class="risk-flag"><span class="sev">[${esc(f.severity)}]</span> <strong>${esc(f.flag)}</strong>: ${esc(f.detail)}</div>`;
        }
    }
    h += "<h4>Rebalancer 判定</h4>";
    if (action) {
        const cls = action.action === "SELL" ? "action-sell" : action.action === "BUY" ? "action-buy" : "action-hold";
        h += summaryTable("", [
            ["action", `<span class="${cls}">${esc(action.action)}</span>`],
            ["current_weight", `${(action.current_weight * 100).toFixed(1)}%`],
            ["target_weight", `${(action.target_weight * 100).toFixed(1)}%`],
            ["delta", `${(action.delta * 100).toFixed(1)}%`],
            ["reason", action.reason],
        ]);
    }
    else {
        h += `<p class="muted">无对应 action</p>`;
    }
    if (positionTrace) {
        h += `<h4>仓位计算溯源</h4>`;
        h += codeBlock(positionTrace);
    }
    return h;
}
// ── 主入口 ──────────────────────────────────────────────────────────────────
function generateDataTraceReport(ticker, name, stockData, stockReport, action, positionTrace) {
    let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>数据管道: ${esc(ticker)} ${esc(name)}</title>
${CSS}
</head>
<body>
<h1>${esc(ticker)} ${esc(name)}</h1>
<p class="subtitle">数据管道调试视图 &mdash; API 请求 &rarr; 数据处理 &rarr; LLM prompt &rarr; LLM 响应 &rarr; 下游决策</p>`;
    // ── 一、子源调用记录 ──
    if (stockData.calls && stockData.calls.length > 0) {
        html += `<hr class="section-divider"><h2>一、子源调用记录</h2>`;
        html += `<div class="call-flow">`;
        for (const c of stockData.calls) {
            html += callRow(c);
        }
        html += `</div>`;
        // 详细记录折叠
        let detailHtml = "";
        for (const c of stockData.calls) {
            const ok = c.success;
            const icon = ok ? "&#10003;" : "&#10007;";
            detailHtml += `<h4>${icon} ${esc(c.stage)}</h4>`;
            const rows = [];
            if (c.url)
                rows.push(["请求 URL", c.url]);
            if (c.status_code)
                rows.push(["HTTP 状态码", String(c.status_code)]);
            if (c.duration_ms)
                rows.push(["耗时", `${c.duration_ms}ms`]);
            if (c.response_size)
                rows.push(["响应大小", `${c.response_size} bytes`]);
            if (c.error)
                rows.push(["错误", c.error]);
            detailHtml += detailTable(rows);
            if (c.response_snippet) {
                detailHtml += `<h4>响应内容</h4>`;
                detailHtml += codeBlock(c.response_snippet.slice(0, 2000) + (c.response_snippet.length > 2000 ? "\n... (truncated)" : ""), "json");
            }
        }
        html += details("展开全部调用详情", detailHtml);
    }
    // ── 二、数据处理链路 ──
    html += `<hr class="section-divider"><h2>二、数据处理链路</h2>`;
    html += `<div class="card">`;
    html += traceKline(stockData);
    html += traceNews(stockData);
    html += traceHotMoney(stockData);
    html += traceFundamentals(stockData);
    html += traceVpaMacd(stockData);
    html += traceLockup(stockData);
    html += `</div>`;
    // ── 三、LLM 交互 ──
    html += `<hr class="section-divider"><h2>三、LLM 交互</h2>`;
    // analyst prompt
    html += `<h3>7. 完整 analyst prompt</h3>`;
    html += details("展开 prompt 全文", codeBlock((0, shallow_analyzer_1.formatAnalystPrompt)(stockData), "markdown"));
    if (stockReport) {
        // LLM 返回
        html += `<h3>8. LLM 返回（analyst-role）</h3>`;
        html += codeBlock(JSON.stringify({
            thesis: stockReport.thesis,
            fitness_score: stockReport.fitness_score,
            key_signals: stockReport.key_signals,
            data_gaps: stockReport.data_gaps,
        }, null, 2), "json");
        // risk prompt
        html += `<h3>9. 完整 risk prompt</h3>`;
        const mockAnalyst = {
            thesis: stockReport.thesis,
            fitness_score: stockReport.fitness_score,
            data_freshness: "",
            key_signals: stockReport.key_signals,
            data_gaps: stockReport.data_gaps,
        };
        html += details("展开 prompt 全文", codeBlock((0, shallow_analyzer_1.formatRiskPrompt)(stockData, mockAnalyst), "markdown"));
        // 决策链
        html += traceDecisionChain(stockReport, action, positionTrace);
    }
    html += `</body></html>`;
    return html;
}
//# sourceMappingURL=data-trace-report.js.map