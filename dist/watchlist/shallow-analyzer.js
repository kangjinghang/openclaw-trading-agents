"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatAnalystPrompt = formatAnalystPrompt;
exports.parseAnalystReport = parseAnalystReport;
exports.formatRiskPrompt = formatRiskPrompt;
exports.parseRiskReport = parseRiskReport;
exports.buildStockReport = buildStockReport;
exports.buildFallbackReport = buildFallbackReport;
exports.analyzeAll = analyzeAll;
const ANALYST_PROMPT_TEMPLATE = `# 角色
你是 A 股证券分析师，对单只股票做综合评估。

# 任务
基于以下数据，输出 thesis + fitness + 关键信号。要求 reason 含具体词（产品/客户/数据/业务节点），
禁止模糊词（共振/资金追捧/活跃/爆发力强）。

# 评分标准（fitness_score，必须严格对齐，不要凭感觉）

| 分数 | 含义 | 典型特征 |
|------|------|---------|
| 9-10 | 顶级 | 业绩已兑现（净利正增）+ 订单/产能可见 + 行业景气 + 估值合理（PE<行业均值） |
| 8 | 好 | 驱动明确（订单/涨价/政策落地）+ 数据支撑 + 风险可控，但有一项未完全验证 |
| 7 | 还行 | 有逻辑但部分未验证，或估值偏高/周期性强/需更多数据确认 |
| 5-6 | 弱 | 概念早期/传闻未证实/单一客户依赖/数据缺失/业绩亏损 |
| ≤4 | 差 | 零营收/财务造假/退市风险/纯资金炒作无实质逻辑 |

评分原则：
- 有具体数据支撑（净利数字、订单金额、产能吨数）才能给 8 分以上
- "传闻""预计""市场传言"类未经证实的信息，最多 6 分
- 数据缺失（PE/净利为 0）应在 data_gaps 标注，fitness 不超过 6（无法证实业绩）

# 股票
{ticker} {name}（行业：{sector}）

# 数据
## K 线（5 日 +{pct_5d}% / 20 日 +{pct_20d}%，支撑 {support} / 压力 {resistance}）
## 新闻（最近 7 天 top）
{news_bullets}
## 资金流向（5 日净流入 {net_5d}）
## 基本面（PE {pe} / PB {pb} / Q1 营收 {rev_q1} / Q1 净利 {np_q1}）
{ranker_section}

# 输出格式（严格 JSON）
{
  "thesis": "...",
  "fitness_score": 0-10,
  "data_freshness": "YYYY-MM-DD",
  "key_signals": ["...", "..."],
  "data_gaps": ["..."]
}`;
function formatAnalystPrompt(d) {
    const newsBullets = d.news.map(n => `- ${n}`).join("\n") || "- (无)";
    const rankerSection = d.ranker_thesis ? `## ranker 评估（ranker 给的 thesis）\n${d.ranker_thesis}` : "";
    return ANALYST_PROMPT_TEMPLATE
        .replace("{ticker}", d.ticker)
        .replace("{name}", d.name)
        .replace("{sector}", d.sector)
        .replace("{pct_5d}", String(d.kline.pct_5d))
        .replace("{pct_20d}", String(d.kline.pct_20d))
        .replace("{support}", String(d.kline.support))
        .replace("{resistance}", String(d.kline.resistance))
        .replace("{news_bullets}", newsBullets)
        .replace("{net_5d}", String(d.hot_money.net_5d))
        .replace("{pe}", String(d.fundamentals.pe))
        .replace("{pb}", String(d.fundamentals.pb))
        .replace("{rev_q1}", String(d.fundamentals.rev_q1))
        .replace("{np_q1}", String(d.fundamentals.np_q1))
        .replace("{ranker_section}", rankerSection);
}
/** 解析 analyst-role 输出。非 JSON / 缺字段返回 null（或填默认值）。 */
function parseAnalystReport(content) {
    const obj = extractJson(content);
    if (!obj || typeof obj !== "object")
        return null;
    const o = obj;
    return {
        thesis: typeof o.thesis === "string" ? o.thesis : "",
        fitness_score: typeof o.fitness_score === "number" ? o.fitness_score : 0,
        data_freshness: typeof o.data_freshness === "string" ? o.data_freshness : "",
        key_signals: Array.isArray(o.key_signals) ? o.key_signals.filter(s => typeof s === "string") : [],
        data_gaps: Array.isArray(o.data_gaps) ? o.data_gaps.filter(s => typeof s === "string") : [],
    };
}
/** 从 LLM 输出抽 JSON（先 ```json 代码块，再找平衡花括号）。 */
function extractJson(content) {
    if (!content)
        return null;
    const codeBlock = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) {
        try {
            return JSON.parse(codeBlock[1].trim());
        }
        catch { /* fall through */ }
    }
    const start = content.indexOf("{");
    if (start === -1)
        return null;
    let depth = 0, endIdx = -1, inStr = false, escape = false;
    for (let i = start; i < content.length; i++) {
        const ch = content[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (ch === "\\") {
            escape = true;
            continue;
        }
        if (ch === '"') {
            inStr = !inStr;
            continue;
        }
        if (inStr)
            continue;
        if (ch === "{")
            depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) {
                endIdx = i;
                break;
            }
        }
    }
    if (endIdx === -1)
        return null;
    try {
        return JSON.parse(content.slice(start, endIdx + 1));
    }
    catch {
        return null;
    }
}
const RISK_PROMPT_TEMPLATE = `# 角色
你是 A 股风险分析师，独立识别单只股票的关键风险。

# 任务
基于以下数据 + analyst 给的 thesis，输出风险清单。不要做 Buy/Sell 判断。

## 量价背离识别规则（重点）
若以下任一成立，应输出对应 risk_flag 并酌情提升 overall_risk（medium→high，low→medium）：
- VPA 预计算数据出现"顶部背离信号"（价格上涨但成交量递减，动能衰竭）
- VPA 预计算数据出现"放量滞涨"（巨量但价格不动，多空分歧大）
- 5 日涨幅较大（>10%）但量比 volume_ratio_5_20 < 0.8（缩量上涨，资金不认可）
这些是技术性见顶信号，与基本面好坏无关——业绩再好，技术见顶也是风险。

# 股票
{ticker} {name}（行业：{sector}）

# 数据
## K 线（5 日 +{pct_5d}% / 20 日 +{pct_20d}%，量比 {volume_ratio_5_20}）
- 量比 < 0.8 = 缩量；> 1.2 = 放量；0.8-1.2 = 正常
## 资金流向（5 日净流入 {net_5d}）
## 基本面（PE {pe} / PB {pb} / Q1 营收 {rev_q1} / Q1 净利 {np_q1}）

## VPA 量价预计算
{vpa_text}

# Analyst thesis
{analyst_thesis}

# 输出格式（严格 JSON）
{
  "risk_flags": [
    { "flag": "...", "severity": "低|中|高", "detail": "..." }
  ],
  "overall_risk": "low|medium|high",
  "deal_breaker": false
}

deal_breaker=true 仅限：财务造假、退市风险、重大违规、产品/客户重大断裂等灾难性情况。`;
function formatRiskPrompt(d, analyst) {
    return RISK_PROMPT_TEMPLATE
        .replace("{ticker}", d.ticker)
        .replace("{name}", d.name)
        .replace("{sector}", d.sector)
        .replace("{pct_5d}", String(d.kline.pct_5d))
        .replace("{pct_20d}", String(d.kline.pct_20d))
        .replace("{volume_ratio_5_20}", String(d.kline.volume_ratio_5_20))
        .replace("{net_5d}", String(d.hot_money.net_5d))
        .replace("{pe}", String(d.fundamentals.pe))
        .replace("{pb}", String(d.fundamentals.pb))
        .replace("{rev_q1}", String(d.fundamentals.rev_q1))
        .replace("{np_q1}", String(d.fundamentals.np_q1))
        .replace("{vpa_text}", d.vpa_text || "(无 VPA 数据)")
        .replace("{analyst_thesis}", `${analyst.thesis}（fitness ${analyst.fitness_score}）`);
}
function parseRiskReport(content) {
    const obj = extractJson(content);
    if (!obj || typeof obj !== "object")
        return null;
    const o = obj;
    const flags = Array.isArray(o.risk_flags) ? o.risk_flags
        .filter((x) => !!x && typeof x === "object")
        .map(x => ({
        flag: typeof x.flag === "string" ? x.flag : "",
        severity: (["低", "中", "高"].includes(x.severity) ? x.severity : "低"),
        detail: typeof x.detail === "string" ? x.detail : "",
    })) : [];
    const risk = ["low", "medium", "high"].includes(o.overall_risk) ? o.overall_risk : "low";
    return {
        risk_flags: flags,
        overall_risk: risk,
        deal_breaker: o.deal_breaker === true,
    };
}
/** 合并 candidate meta + analyst report + risk report → 完整 StockReport。 */
function buildStockReport(meta, sector, analyst, risk) {
    return {
        ticker: meta.ticker,
        name: meta.name,
        sector,
        thesis: analyst.thesis,
        fitness_score: analyst.fitness_score,
        key_signals: analyst.key_signals,
        data_gaps: analyst.data_gaps,
        risk_flags: risk.risk_flags,
        overall_risk: risk.overall_risk,
        deal_breaker: risk.deal_breaker,
        is_held: meta.is_held,
        current_weight: meta.current_weight,
        days_held: meta.days_held,
        locked: meta.locked,
        ranker_score: meta.ranker_score,
    };
}
/** 持仓股 shallow-analyzer 失败时的保守默认 report。
 *
 *  为什么持仓股不能像候选股一样"失败就消失"：
 *  - 候选股失败 = 少一个机会（损失小）
 *  - 持仓股失败 = 漏看一个风险（损失大）—— rebalancer 既不 HOLD 也不 REDUCE，
 *    一个用户实际持有的、可能需要止损的股被静默忽略
 *
 *  默认值设计（逼 rebalancer 面对，但不乱下结论）：
 *  - fitness=5：触发"持仓 fitness≤5 必须 REDUCE/SELL"硬规则，rebalancer 必须提它
 *  - risk=high：数据缺失=未知风险，仓位公式会打折
 *  - deal_breaker=false：无证据不清仓（清仓是重大决策）
 *  - locked 保留：anti-churn 卖锁仍生效，不会乱减锁定股 */
function buildFallbackReport(meta, sector, reason) {
    return {
        ticker: meta.ticker,
        name: meta.name,
        sector,
        thesis: `⚠️ shallow-analyzer 失败，无法评估（${reason}）`,
        fitness_score: 5,
        key_signals: [],
        data_gaps: [`shallow-analyzer 失败：${reason}`],
        risk_flags: [{ flag: "分析失败", severity: "高", detail: reason }],
        overall_risk: "high",
        deal_breaker: false,
        is_held: meta.is_held,
        current_weight: meta.current_weight,
        days_held: meta.days_held,
        locked: meta.locked,
        ranker_score: meta.ranker_score,
    };
}
/** 对所有候选/持仓股跑 analyst + risk 双 call（单股内串行，跨股并发限制）。
 *
 *  失败处理（风控关键）：
 *  - 候选股失败 → 跳过（少一个机会，无伤大雅）
 *  - 持仓股失败 → 保守默认 report（fitness=5, risk=high），不消失
 *    否则 rebalancer 看不到它，一个可能需要止损的持仓股被静默忽略
 *
 *  concurrency 默认 3 —— zhipu glm-5.1 free tier 在并发 ≥5 时触发 429。
 *  跨股 worker pool + 单股内 analyst→risk 串行 = 任意时刻最多 concurrency 个 LLM call。 */
async function analyzeAll(metas, dataByTicker, caller, concurrency = 3) {
    const queue = [...metas];
    const results = [];
    const workers = [];
    for (let w = 0; w < concurrency; w++) {
        workers.push((async () => {
            while (queue.length > 0) {
                const meta = queue.shift();
                const data = dataByTicker.get(meta.ticker);
                if (!data) {
                    // 持仓股无数据 → fallback（候选股跳过）
                    results.push(meta.is_held ? buildFallbackReport(meta, "未分类", "数据拉取失败（dataByTicker 无此股）") : null);
                    continue;
                }
                try {
                    const analystContent = await caller({ role: "analyst", data });
                    const analyst = parseAnalystReport(analystContent);
                    if (!analyst) {
                        results.push(meta.is_held ? buildFallbackReport(meta, data.sector, "analyst-role 返回非 JSON") : null);
                        continue;
                    }
                    const riskContent = await caller({ role: "risk", data, analyst });
                    const risk = parseRiskReport(riskContent);
                    if (!risk) {
                        results.push(meta.is_held ? buildFallbackReport(meta, data.sector, "risk-role 返回非 JSON") : null);
                        continue;
                    }
                    results.push(buildStockReport(meta, data.sector, analyst, risk));
                }
                catch (e) {
                    const reason = e instanceof Error ? e.message : String(e);
                    results.push(meta.is_held ? buildFallbackReport(meta, data.sector, `LLM 调用异常：${reason}`) : null);
                }
            }
        })());
    }
    await Promise.all(workers);
    return results.filter((r) => r !== null);
}
//# sourceMappingURL=shallow-analyzer.js.map