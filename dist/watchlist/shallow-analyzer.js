"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderHotMoneySummary = renderHotMoneySummary;
exports.renderQuarterlyTrends = renderQuarterlyTrends;
exports.renderConsensus = renderConsensus;
exports.renderLockup = renderLockup;
exports.renderMacd = renderMacd;
exports.renderPercentileLabel = renderPercentileLabel;
exports.formatAnalystPrompt = formatAnalystPrompt;
exports.parseAnalystReport = parseAnalystReport;
exports.formatRiskPrompt = formatRiskPrompt;
exports.parseRiskReport = parseRiskReport;
exports.buildStockReport = buildStockReport;
exports.buildFallbackReport = buildFallbackReport;
exports.analyzeAll = analyzeAll;
const quality_gate_1 = require("./quality-gate");
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
- 季度营收/净利连续正增长（quarterly_trends 可见同比）是业绩兑现的硬证据，可支撑 8 分以上；反之连续下滑应在 thesis 标注并压低 fitness
- 机构一致预期（consensus_eps）正向 + 目标价高于现价 = 卖方认可，可作为加分项；但预期本身不算业绩兑现
- "传闻""预计""市场传言"类未经证实的信息，最多 6 分
- 数据缺失（PE/净利为 0）应在 data_gaps 标注，fitness 不超过 6（无法证实业绩）

# 股票
{ticker} {name}（行业：{sector}）

# 数据
## K 线（5 日 +{pct_5d}% / 20 日 +{pct_20d}%，支撑 {support} / 压力 {resistance}）
## 新闻（最近 7 天 top，含时间与正文摘要）
{news_density}{news_bullets}
（注意时效：最近 1-2 天的突发新闻权重高于一周前的旧闻；标题党风险——标题与正文矛盾时以正文为准）
## 资金流向
{hot_money_summary}
## 基本面（PE {pe}{pe_label} / PB {pb}{pb_label} / Q1 营收 {rev_q1} / Q1 净利 {np_q1}）
## 季度业绩趋势（近 4 季度营收/净利/ROE + 同比，判断业绩连续性）
{quarterly_trends}
## 机构一致预期（卖方覆盖数 / EPS 预期 / 目标价 / 评级）
{consensus_eps}
{ranker_section}

# 输出格式（严格 JSON）
{
  "thesis": "...",
  "fitness_score": 0-10,
  "data_freshness": "YYYY-MM-DD",
  "key_signals": ["...", "..."],
  "data_gaps": ["..."]
}`;
/** 把 HotMoneyData 渲染成 prompt 里的一行紧凑资金面摘要。
 *
 *  范式对齐 newsDensity（news_layer_stats）：有则一行管道分隔，无则兜底标注。
 *  把全局子源压成一句：
 *  "北向 +2.3亿(inflow) | 龙虎榜近30天2次(最近+1.2亿) | 所在行业未在当日主线 | 今日热门:半导体/军工/锂电"
 *
 *  兜底：所有标量全 0 且无任何文本片段 → "(资金数据拉取失败或全空)"，
 *  让 LLM 知道资金面维度无数据（诚实标注缺失，不编造）。 */
function signPrefix(n) {
    return n > 0 ? "+" : "";
}
function renderHotMoneySummary(h) {
    const parts = [];
    // 北向资金（全市场外资情绪风向标）
    if (h.northbound_signal) {
        const sig = h.northbound_signal === "inflow" ? "流入" : "流出";
        parts.push(`北向${signPrefix(h.northbound_yi)}${h.northbound_yi.toFixed(2)}亿(${sig})`);
    }
    // 龙虎榜（游资/机构席位动向）+ 上榜原因（区分游资炒作 vs 业绩驱动）
    if (h.dragon_tiger_recent) {
        const reason = h.dragon_tiger_reason ? `，原因:${h.dragon_tiger_reason}` : "";
        parts.push(`龙虎榜近30天:${h.dragon_tiger_recent}${reason}`);
    }
    // 板块轮动（标的行业是否当日主线）+ 流入/流出 top 名单
    if (h.sector_in_industry_tag) {
        const tag = h.sector_in_industry_tag === "主线" ? "所在行业在当日流入主线"
            : h.sector_in_industry_tag === "弱势" ? "所在行业在当日流出弱势区"
                : "所在行业未上当日板块榜";
        const inflow = h.sector_inflow_top ? `(流入top:${h.sector_inflow_top})` : "";
        const outflow = h.sector_outflow_top ? `(流出top:${h.sector_outflow_top})` : "";
        parts.push(`${tag}${inflow}${outflow}`);
    }
    // 今日热门题材
    if (h.hot_stocks_top) {
        parts.push(`今日热门:${h.hot_stocks_top}`);
    }
    if (parts.length === 0) {
        return "(资金数据拉取失败或全空)";
    }
    return parts.join(" | ");
}
/** 把 4 季度财务趋势压成一行（对齐 renderHotMoneySummary 范式）。
 *
 *  格式：「营收 285/1200/880/560亿(同比+10.5/+8.2/+7.1/+6.0%) | 净利 32/130/95/60亿(同比...) | ROE 4.2/15.6/11.5/7.8%」
 *  - 按报告期降序（最近在前，对齐 fundamentals.py quarterly_trends 的排序）
 *  - 每段只在该段有数据时输出；缺同比 → 省略括号；无任何数据 → 空串（prompt 该行省略）
 *  - 负同比带负号（业绩下滑是风险信号，LLM 需识别）
 *  季度顺序由 fundamentals.py 的 sortColumns=REPORTDATE desc 保证，这里原样按数组顺序渲染。 */
function renderQuarterlyTrends(trends) {
    if (!trends || trends.length === 0)
        return "";
    const sign = (n) => n > 0 ? `+${n}` : `${n}`;
    // 营收段：有 revenue_yi 的季度才进；同比仅当该季度有 revenue_yoy 时拼
    const revVals = [];
    const revYoy = [];
    trends.forEach(t => {
        if (typeof t.revenue_yi === "number")
            revVals.push(`${t.revenue_yi}亿`);
        if (typeof t.revenue_yoy === "number")
            revYoy.push(`${sign(t.revenue_yoy)}%`);
    });
    const npVals = [];
    const npYoy = [];
    trends.forEach(t => {
        if (typeof t.net_profit_yi === "number")
            npVals.push(`${t.net_profit_yi}亿`);
        if (typeof t.net_profit_yoy === "number")
            npYoy.push(`${sign(t.net_profit_yoy)}%`);
    });
    const roeVals = trends
        .filter(t => typeof t.roe === "number")
        .map(t => `${t.roe}%`);
    const segs = [];
    if (revVals.length) {
        const yoy = revYoy.length ? `(同比${revYoy.join("/")})` : "";
        segs.push(`营收 ${revVals.join("/")}${yoy}`);
    }
    if (npVals.length) {
        const yoy = npYoy.length ? `(同比${npYoy.join("/")})` : "";
        segs.push(`净利 ${npVals.join("/")}${yoy}`);
    }
    if (roeVals.length)
        segs.push(`ROE ${roeVals.join("/")}`);
    return segs.join(" | ");
}
/** 把机构一致预期压成一行（对齐 renderHotMoneySummary 范式）。
 *
 *  格式：「26家覆盖 | EPS 45→52(+15.6%) | 目标价 1800-2000 | 评级 买18/增5/中性3 | 远期PE 34.6 | PEG 2.2」
 *  - 每段只在该字段有值时输出；无任何数据 → 空串（很多小盘股无机构覆盖，prompt 该行省略）
 *  - 负增速带负号（预期下滑是风险信号）
 *  - PEG 仅当脚本预计算给出时输出（fundamentals.py 仅正增长时算 PEG，故缺 PEG 不代表数据错）
 *  - 评级分布只列非零项，避免「买0/增0/中性0」噪音
 *  forward_pe/peg 由 fundamentals.py 预计算，LLM 只引用不算（避免算术错误）。 */
function renderConsensus(c) {
    if (!c)
        return "";
    const sign = (n) => n > 0 ? `+${n}` : `${n}`;
    const segs = [];
    if (typeof c.analyst_count === "number" && c.analyst_count > 0) {
        segs.push(`${c.analyst_count}家覆盖`);
    }
    // EPS 趋势：current → next，有增速则带括号
    if (typeof c.consensus_eps_current === "number" || typeof c.consensus_eps_next === "number") {
        const cur = typeof c.consensus_eps_current === "number" ? c.consensus_eps_current : "?";
        const nxt = typeof c.consensus_eps_next === "number" ? c.consensus_eps_next : "?";
        const growth = typeof c.eps_growth_pct === "number" ? `(${sign(c.eps_growth_pct)}%)` : "";
        segs.push(`EPS ${cur}→${nxt}${growth}`);
    }
    if (typeof c.target_price_min === "number" && typeof c.target_price_max === "number"
        && c.target_price_min > 0 && c.target_price_max > 0) {
        segs.push(`目标价 ${c.target_price_min}-${c.target_price_max}`);
    }
    if (c.ratings) {
        const r = c.ratings;
        const label = [
            ["买", r.buy], ["增", r.overweight], ["中性", r.neutral], ["减", r.underweight], ["卖", r.sell],
        ];
        const parts = label.filter(([, n]) => typeof n === "number" && n > 0)
            .map(([lab, n]) => `${lab}${n}`);
        if (parts.length)
            segs.push(`评级 ${parts.join("/")}`);
    }
    if (typeof c.forward_pe === "number" && c.forward_pe > 0)
        segs.push(`远期PE ${c.forward_pe}`);
    if (typeof c.peg === "number" && c.peg > 0)
        segs.push(`PEG ${c.peg}`);
    return segs.join(" | ");
}
/** 把解禁+减持压成一行（对齐 renderHotMoneySummary/renderQuarterlyTrends 范式）。
 *
 *  格式：「解禁压力：重大压力 | 未来90天2笔(最近 07-15 定增 0.4%；09-20 首发 1.2%) | 近期减持1笔(大股东 2.1%，个人资金需求)」
 *  - 压力评级（lockup.py pressure_rating，按 upcoming 数量给的档）
 *  - upcoming 取最近 3 笔（脚本已按日期升序），每笔：MM-DD 类型 ratio
 *  - reduce_holdings 取最近 2 笔（脚本按日期倒序），每笔：股东 ratio 原因
 *  每段只在该段有数据时输出；无 upcoming 且无减持 → 只输出压力评级行（让 LLM 知道无压力）。
 *  ratio 字段是字符串（如"0.4%"），原样透传让 LLM 读，避免 parse 失败丢信息。 */
function renderLockup(l) {
    const segs = [];
    // 压力评级（lockup.py 按 upcoming 数量分档，重大压力 = ≥3 笔）
    segs.push(`解禁压力：${l.pressure_rating || "未知"}`);
    // 未来解禁：取前 3 笔（最近在前，upcoming 已按日期升序）
    if (l.upcoming && l.upcoming.length > 0) {
        const items = l.upcoming.slice(0, 3).map(it => {
            const d = it.date ? it.date.slice(5) : "?"; // MM-DD
            const t = it.type || "解禁";
            const r = it.ratio ? ` ${it.ratio}` : "";
            return `${d} ${t}${r}`;
        });
        segs.push(`未来90天${l.upcoming.length}笔(${items.join("；")})`);
    }
    // 近期减持：取前 2 笔（已按日期倒序）
    if (l.reduce_holdings && l.reduce_holdings.length > 0) {
        const items = l.reduce_holdings.slice(0, 2).map(rd => {
            const who = rd.reducing_shareholder ? rd.reducing_shareholder.slice(0, 8) : "股东";
            const r = rd.reducing_ratio ? ` ${rd.reducing_ratio}` : "";
            const reason = rd.reduce_reason ? `，${rd.reduce_reason.slice(0, 12)}` : "";
            return `${who}${r}${reason}`;
        });
        segs.push(`近期减持${l.reduce_holdings.length}笔(${items.join("；")})`);
    }
    return segs.join(" | ");
}
/** 渲染 MACD 动量信号为一行文本。无数据 → 空串（prompt 该行省略）。
 *  格式：「DIF=0.523 DEA=0.481 柱状图=0.042 多头｜金叉」
 *  让 LLM 识别动量方向 + 交叉信号（金叉=看多加速，死叉=看空加速）。 */
function renderMacd(m) {
    if (!m)
        return "";
    const parts = [`DIF=${m.dif}`, `DEA=${m.dea}`, `柱状图=${m.histogram}`];
    parts.push(m.direction);
    if (m.crossover === "golden")
        parts.push("金叉");
    else if (m.crossover === "death")
        parts.push("死叉");
    return parts.join(" | ");
}
/** 渲染 PE/PB 历史分位标注（如「[近5年15%分位]」），无数据 → 空串（向后兼容）。
 *  分位含义：0-100，表示当前值在近5年序列里的位置——低分位=相对便宜，高分位=相对贵。
 *  让 LLM 据此判断"PE=18 在该股历史上贵不贵"，治绝对值盲区。 */
function renderPercentileLabel(percentile) {
    if (typeof percentile !== "number" || !Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
        return "";
    }
    return `[近5年${percentile}%分位]`;
}
function formatAnalystPrompt(d) {
    const newsBullets = d.news.map(n => {
        const time = n.time ? `[${n.time}] ` : "";
        const content = n.content ? `：${n.content}` : "";
        return `- ${time}${n.title}${content}`;
    }).join("\n") || "- (无)";
    // 新闻密度统计：news.py layer_stats 的一行渲染。无统计 → 空串（该行省略）。
    // 让 LLM 判断热门/冷门（total 低=流动性风险）+ 有无突发（realtime_6h>0=提权重）。
    const newsDensity = d.news_layer_stats
        ? `新闻密度：6h 内 ${d.news_layer_stats.realtime_6h_count} 条突发 / 24h 内 ${d.news_layer_stats.extended_24h_count} 条 / 7 天共 ${d.news_layer_stats.total_categorized} 条\n`
        : "";
    const rankerSection = d.ranker_thesis ? `## ranker 评估（ranker 给的 thesis）\n${d.ranker_thesis}` : "";
    return ANALYST_PROMPT_TEMPLATE
        .replace("{ticker}", d.ticker)
        .replace("{name}", d.name)
        .replace("{sector}", d.sector)
        .replace("{pct_5d}", d.kline.pct_5d.toFixed(2))
        .replace("{pct_20d}", d.kline.pct_20d.toFixed(2))
        .replace("{support}", d.kline.support.toFixed(2))
        .replace("{resistance}", d.kline.resistance.toFixed(2))
        .replace("{news_density}", newsDensity)
        .replace("{news_bullets}", newsBullets)
        .replace("{hot_money_summary}", renderHotMoneySummary(d.hot_money))
        .replace("{pe}", String(d.fundamentals.pe))
        .replace("{pe_label}", renderPercentileLabel(d.fundamentals.pe_percentile))
        .replace("{pb}", String(d.fundamentals.pb))
        .replace("{pb_label}", renderPercentileLabel(d.fundamentals.pb_percentile))
        .replace("{rev_q1}", d.fundamentals.rev_q1 > 0 ? `${(d.fundamentals.rev_q1 / 1e8).toFixed(2)}亿` : String(d.fundamentals.rev_q1))
        .replace("{np_q1}", d.fundamentals.np_q1 > 0 ? `${(d.fundamentals.np_q1 / 1e8).toFixed(2)}亿` : String(d.fundamentals.np_q1))
        // 季度趋势/机构预期：render 返回空串 → 整段标题下内容空白，LLM 理解为"无此数据"。
        .replace("{quarterly_trends}", renderQuarterlyTrends(d.fundamentals.quarterly_trends) || "(无季度趋势数据)")
        .replace("{consensus_eps}", renderConsensus(d.fundamentals.consensus_eps) || "(无机构覆盖)")
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

## 解禁与减持识别规则（重点）
若以下任一成立，应输出对应 risk_flag 并提升 overall_risk（重大解禁→high）：
- 解禁压力评级为"重大压力"（未来 90 天 ≥3 笔解禁）
- 未来 90 天有单笔解禁比例 ≥5%（流通市值，供给冲击大）
- 近期有大股东减持记录（减持动力强，后续可能持续减持）
这些是供给端压力，与公司好坏无关——业绩再好，解禁抛压也是风险。

# 股票
{ticker} {name}（行业：{sector}）

# 数据
## K 线（5 日 +{pct_5d}% / 20 日 +{pct_20d}%，量比 {volume_ratio_5_20}）
- 量比 < 0.8 = 缩量；> 1.2 = 放量；0.8-1.2 = 正常
## 资金流向
{hot_money_summary}
## 基本面（PE {pe}{pe_label} / PB {pb}{pb_label} / Q1 营收 {rev_q1} / Q1 净利 {np_q1}）
## 季度业绩趋势（营收/净利同比连续下滑 = 业绩拐点风险，应输出 risk_flag）
{quarterly_trends}

## VPA 量价预计算
{vpa_text}

## MACD 动量信号
{macd_text}

## 解禁与减持（未来 90 天解禁 + 近期减持；未来大额解禁或减持 = 供给压力）
{lockup_summary}

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
        .replace("{pct_5d}", d.kline.pct_5d.toFixed(2))
        .replace("{pct_20d}", d.kline.pct_20d.toFixed(2))
        .replace("{volume_ratio_5_20}", d.kline.volume_ratio_5_20.toFixed(2))
        .replace("{hot_money_summary}", renderHotMoneySummary(d.hot_money))
        .replace("{pe}", String(d.fundamentals.pe))
        .replace("{pe_label}", renderPercentileLabel(d.fundamentals.pe_percentile))
        .replace("{pb}", String(d.fundamentals.pb))
        .replace("{pb_label}", renderPercentileLabel(d.fundamentals.pb_percentile))
        .replace("{rev_q1}", d.fundamentals.rev_q1 > 0 ? `${(d.fundamentals.rev_q1 / 1e8).toFixed(2)}亿` : String(d.fundamentals.rev_q1))
        .replace("{np_q1}", d.fundamentals.np_q1 > 0 ? `${(d.fundamentals.np_q1 / 1e8).toFixed(2)}亿` : String(d.fundamentals.np_q1))
        .replace("{quarterly_trends}", renderQuarterlyTrends(d.fundamentals.quarterly_trends) || "(无季度趋势数据)")
        .replace("{vpa_text}", d.vpa_text || "(无 VPA 数据)")
        .replace("{macd_text}", renderMacd(d.macd) || "(无 MACD 数据)")
        .replace("{lockup_summary}", d.lockup ? renderLockup(d.lockup) : "(无解禁数据)")
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
/** 合并 candidate meta + analyst report + risk report → 完整 StockReport。
 *
 *  qualityNotes（可选）：确定性质量门控 applyQualityGate 的产物。传入则落
 *  StockReport.quality_notes，便于复盘"为什么这只股 fitness 从 8 变 6"。
 *  空数组或 undefined → 不写该字段（保持 plan.json 简洁）。 */
function buildStockReport(meta, sector, analyst, risk, qualityNotes) {
    const report = {
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
    if (qualityNotes && qualityNotes.length > 0) {
        report.quality_notes = qualityNotes;
    }
    return report;
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
                    // 确定性质量门控（内联守卫，非新阶段）：钳制 fitness/risk + 标注 issue（含解禁兜底）。
                    // 必须在 buildStockReport 前，让 clamp 后的值进 position-calculator 公式。
                    const gated = (0, quality_gate_1.applyQualityGate)(analyst, risk, data);
                    results.push(buildStockReport(meta, data.sector, gated.analyst, gated.risk, gated.issues));
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