"use strict";
// src/watchlist/data-trace-report.ts
//
// 单股数据管道调试视图：从 API 请求 → 数据处理 → LLM prompt 的完整链路。
// 输出 data-trace.md，让用户看到"一只股的数据是怎么流转的"。
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateDataTraceReport = generateDataTraceReport;
const shallow_analyzer_1 = require("./shallow-analyzer");
// ── 辅助渲染 ────────────────────────────────────────────────────────────────
function fieldRow(label, value, unit = "") {
    if (value === undefined || value === null || value === "")
        return `| ${label} | _(缺失)_ |`;
    const display = typeof value === "number"
        ? (Number.isFinite(value) ? String(value) : "NaN")
        : String(value);
    return `| ${label} | ${display}${unit} |`;
}
function section(title) {
    return ["", `### ${title}`, ""];
}
// ── 4 个数据源的链路追踪 ────────────────────────────────────────────────────
function traceKline(d) {
    const lines = [];
    lines.push(...section("1. K 线（kline.py）"));
    lines.push("**脚本**: `skills/trading-kline/scripts/kline.py`");
    lines.push("**API**: mootdx TDX TCP (7709 端口) → akshare HTTP fallback");
    lines.push("**入参**: ticker, count=120");
    lines.push("");
    lines.push("**原始输出字段（Python → TS）**:");
    lines.push("| 字段 | 值 | 说明 |");
    lines.push("|------|-----|------|");
    lines.push(fieldRow("data[] 长度", d.kline.pct_5d !== 0 ? "120 bars" : "0", "（OHLCV 数组）"));
    lines.push("");
    lines.push("**parseKline() 处理后**:");
    lines.push("| 输出字段 | 值 | 计算方式 |");
    lines.push("|---------|-----|---------|");
    lines.push(fieldRow("pct_5d", d.kline.pct_5d, "%"));
    lines.push(fieldRow("pct_20d", d.kline.pct_20d, "%"));
    lines.push(fieldRow("support", d.kline.support));
    lines.push(fieldRow("resistance", d.kline.resistance));
    lines.push(fieldRow("volatility_20d", d.kline.volatility_20d, "%"));
    lines.push(fieldRow("volume_ratio_5_20", d.kline.volume_ratio_5_20));
    lines.push("");
    lines.push("**→ 注入 prompt 的行**:");
    lines.push("```");
    lines.push(`## K 线（5 日 ${d.kline.pct_5d > 0 ? "+" : ""}${d.kline.pct_5d}% / 20 日 ${d.kline.pct_20d > 0 ? "+" : ""}${d.kline.pct_20d}%，支撑 ${d.kline.support} / 压力 ${d.kline.resistance}）`);
    lines.push("```");
    return lines;
}
function traceNews(d) {
    const lines = [];
    lines.push(...section("2. 新闻（news.py）"));
    lines.push("**脚本**: `skills/trading-news/scripts/news.py`");
    lines.push("**API**: 东方财富搜索 API（search-api-web.eastmoney.com）");
    lines.push("**入参**: ticker, date, lookback_days=7, --skip-macro");
    lines.push("");
    lines.push("**原始输出字段（Python → TS）**:");
    lines.push("| 字段 | 值 | 说明 |");
    lines.push("|------|-----|------|");
    lines.push(fieldRow("stock_news[] 长度", d.news.length, "条"));
    lines.push(fieldRow("layer_stats", d.news_layer_stats ? "有" : "无"));
    lines.push("");
    lines.push("**parseNews() 处理后（每条截取 120 字）**:");
    for (const n of d.news.slice(0, 3)) {
        lines.push(`- **${n.title}**`);
        if (n.content)
            lines.push(`  正文摘要: ${n.content}`);
        if (n.time)
            lines.push(`  时间: ${n.time}`);
    }
    if (d.news.length > 3)
        lines.push(`- ... 共 ${d.news.length} 条`);
    lines.push("");
    lines.push("**→ 注入 prompt 的行**:");
    lines.push("```");
    const bullets = d.news.map(n => {
        const t = n.time ? `[${n.time}] ` : "";
        const c = n.content ? `：${n.content}` : "";
        return `- ${t}${n.title}${c}`;
    }).join("\n");
    lines.push(bullets || "- (无)");
    lines.push("```");
    return lines;
}
function traceHotMoney(d) {
    const lines = [];
    lines.push(...section("3. 资金流向（hot_money.py）"));
    lines.push("**脚本**: `skills/trading-hot-money/scripts/hot_money.py`");
    lines.push("**API**: 5 个子源并行");
    lines.push("| 子源 | API | 说明 |");
    lines.push("|------|-----|------|");
    lines.push("| northbound | 同花顺 data.hexin.cn | 全市场北向资金 |");
    lines.push("| fund_flow | 东财 push2.eastmoney.com | 个股主力资金流 |");
    lines.push("| sector_fund_flow | 东财 push2 | 板块资金流排名 |");
    lines.push("| hot_stocks | 同花顺 zx.10jqka.com.cn | 当日热门股 |");
    lines.push("| dragon_tiger | 东财 datacenter | 龙虎榜 |");
    lines.push("");
    lines.push("**parseHotMoney() 处理后**:");
    lines.push("| 输出字段 | 值 | 说明 |");
    lines.push("|---------|-----|------|");
    lines.push(fieldRow("main_net_today", d.hot_money.main_net_today, "元"));
    lines.push(fieldRow("super_net_today", d.hot_money.super_net_today, "元"));
    lines.push(fieldRow("large_net_today", d.hot_money.large_net_today, "元"));
    lines.push(fieldRow("northbound_yi", d.hot_money.northbound_yi, "亿"));
    lines.push(fieldRow("northbound_signal", d.hot_money.northbound_signal));
    lines.push(fieldRow("dragon_tiger_recent", d.hot_money.dragon_tiger_recent));
    lines.push(fieldRow("sector_in_industry_tag", d.hot_money.sector_in_industry_tag));
    lines.push(fieldRow("hot_stocks_top", d.hot_money.hot_stocks_top));
    lines.push("");
    lines.push("**→ 注入 prompt 的行**:");
    lines.push("```");
    lines.push((0, shallow_analyzer_1.renderHotMoneySummary)(d.hot_money));
    lines.push("```");
    return lines;
}
function traceFundamentals(d) {
    const lines = [];
    lines.push(...section("4. 基本面（fundamentals.py）"));
    lines.push("**脚本**: `skills/trading-fundamentals/scripts/fundamentals.py`");
    lines.push("**API**: 7 个子源");
    lines.push("| 子源 | API | 说明 |");
    lines.push("|------|-----|------|");
    lines.push("| valuation | 腾讯证券 tencent_quote | 实时估值 PE/PB/市值 |");
    lines.push("| financial_snapshot | mootdx finance() | 财务快照（营收/净利/ROE） |");
    lines.push("| stock_info | 东财 push2/datacenter | 行业分类 |");
    lines.push("| quarterly_trends | 东财 datacenter RPT_LICO_FN_CPD | 最近 4 季度趋势 |");
    lines.push("| consensus_eps | 东财 datacenter RPT_WEB_RESPREDICT | 机构一致预期 |");
    lines.push("| financial_health | akshare sina 三大报表 | 财务健康（商誉/负债/现金流） |");
    lines.push("");
    lines.push("**parseFundamentals() 处理后**:");
    lines.push("| 输出字段 | 值 | 来源 |");
    lines.push("|---------|-----|------|");
    lines.push(fieldRow("pe", d.fundamentals.pe));
    lines.push(fieldRow("pb", d.fundamentals.pb));
    lines.push(fieldRow("rev_q1", d.fundamentals.rev_q1));
    lines.push(fieldRow("np_q1", d.fundamentals.np_q1));
    lines.push(fieldRow("industry", d.fundamentals.industry));
    lines.push("");
    if (d.fundamentals.quarterly_trends && d.fundamentals.quarterly_trends.length > 0) {
        lines.push("**季度趋势（renderQuarterlyTrends）**:");
        lines.push("```");
        lines.push((0, shallow_analyzer_1.renderQuarterlyTrends)(d.fundamentals.quarterly_trends));
        lines.push("```");
    }
    if (d.fundamentals.consensus_eps) {
        lines.push("**机构预期（renderConsensus）**:");
        lines.push("```");
        lines.push((0, shallow_analyzer_1.renderConsensus)(d.fundamentals.consensus_eps));
        lines.push("```");
    }
    lines.push("");
    lines.push("**→ 注入 prompt 的行**:");
    lines.push("```");
    lines.push(`## 基本面（PE ${d.fundamentals.pe} / PB ${d.fundamentals.pb} / Q1 营收 ${d.fundamentals.rev_q1} / Q1 净利 ${d.fundamentals.np_q1}）`);
    lines.push("```");
    return lines;
}
// ── 主入口 ──────────────────────────────────────────────────────────────────
/** 生成单股数据管道调试视图（markdown）。 */
function generateDataTraceReport(ticker, name, stockData, stockReport) {
    const lines = [];
    lines.push(`# 数据管道调试视图：${ticker} ${name}`);
    lines.push("");
    lines.push("> 这只股的数据从 API 请求 → 数据处理 → 发给 LLM 的 prompt 的完整链路。");
    lines.push("");
    // 数据源调用记录
    if (stockData.calls && stockData.calls.length > 0) {
        lines.push("## 子源调用记录（HTTP 请求/响应细节）");
        lines.push("");
        for (const c of stockData.calls) {
            const ok = c.success ? "✅" : "❌";
            const dur = c.duration_ms != null ? `${c.duration_ms}ms` : "-";
            lines.push(`### ${ok} ${c.stage}`);
            lines.push("");
            const rows = [];
            if (c.url)
                rows.push(["请求 URL", `\`${c.url}\``]);
            if (c.status_code)
                rows.push(["HTTP 状态码", String(c.status_code)]);
            if (c.duration_ms)
                rows.push(["耗时", `${c.duration_ms}ms`]);
            if (c.response_size)
                rows.push(["响应大小", `${c.response_size} bytes`]);
            if (c.response_snippet)
                rows.push(["响应内容", `\`\`\`json\n${c.response_snippet}\n\`\`\``]);
            if (c.error)
                rows.push(["错误", c.error]);
            if (rows.length > 0) {
                lines.push("| 字段 | 值 |");
                lines.push("|------|-----|");
                for (const [k, v] of rows)
                    lines.push(`| ${k} | ${v} |`);
            }
            lines.push("");
        }
    }
    // 4 个数据源链路
    lines.push(...traceKline(stockData));
    lines.push(...traceNews(stockData));
    lines.push(...traceHotMoney(stockData));
    lines.push(...traceFundamentals(stockData));
    // 完整 prompt 预览
    lines.push(...section("5. 完整 analyst prompt（发给 LLM 的）"));
    lines.push("> 以下就是 formatAnalystPrompt() 输出的完整内容，直接喂给 LLM。");
    lines.push("");
    lines.push("```markdown");
    lines.push((0, shallow_analyzer_1.formatAnalystPrompt)(stockData));
    lines.push("```");
    if (stockReport) {
        lines.push(...section("6. LLM 返回（analyst-role）"));
        lines.push("```json");
        lines.push(JSON.stringify({
            thesis: stockReport.thesis,
            fitness_score: stockReport.fitness_score,
            key_signals: stockReport.key_signals,
            data_gaps: stockReport.data_gaps,
        }, null, 2));
        lines.push("```");
        lines.push(...section("7. 完整 risk prompt（发给 LLM 的）"));
        lines.push("> 以下就是 formatRiskPrompt() 输出的完整内容，直接喂给 LLM。");
        lines.push("");
        lines.push("```markdown");
        // 构造一个最小的 AnalystReport 供 formatRiskPrompt 使用
        const mockAnalyst = {
            thesis: stockReport.thesis,
            fitness_score: stockReport.fitness_score,
            data_freshness: "",
            key_signals: stockReport.key_signals,
            data_gaps: stockReport.data_gaps,
        };
        lines.push((0, shallow_analyzer_1.formatRiskPrompt)(stockData, mockAnalyst));
        lines.push("```");
    }
    return lines.join("\n");
}
//# sourceMappingURL=data-trace-report.js.map