import type { AnalystReport, RiskFlag, RiskReport, StockReport } from "./rebalance-types";
import type { CandidateMeta } from "./candidate-selector";

export type ShallowLlmCaller = (input: {
  role: "analyst" | "risk";
  data: StockData;
  analyst?: AnalystReport;
}) => Promise<string>;

/** 单条新闻。title 必有；content/time/source 可缺（数据源差异或拉取失败）。 */
export interface NewsItem {
  title: string;
  content?: string;
  time?: string;
  source?: string;
}

/** 新闻时间分层数量统计（news.py 的 layer_stats）。
 *  反映个股的市场关注密度 + 突发性，是 shallow 判断"热门/冷门"和"有无突发"的关键信号。
 *  - realtime_6h_count：最近 6 小时新闻数（>0 = 有突发，提权重）
 *  - total_categorized：7 天总条数（低 = 冷门股，流动性风险）
 *  全部 0 或 undefined = 无统计（拉取失败或字段缺失），不阻塞分析。 */
export interface NewsLayerStats {
  realtime_6h_count: number;
  extended_24h_count: number;
  history_7d_count: number;
  total_categorized: number;
}

/** 资金面摘要（来自 hot_money.py 的 5 个子源，parseHotMoney 预压缩为浅层字段 + 文本片段）。
 *
 *  ⚠️ 字段命名诚实：main_net_today 是「当日」主力净流入，不是 5 日累计——
 *  hot_money.py 的 _fetch_fund_flow 只解析最后一根日 K（klt=1, klines[-1]），
 *  没有 5 日聚合逻辑。老实现字段叫 net_5d 但实际取不到值（顶层无此字段，恒 0），
 *  此处修正为 main_net_today 与脚本语义对齐，避免误导 LLM 把当日数字当成 5 日趋势。
 *
 *  - 标量字段（main_net_today / *_net_today / northbound_*）：缺失或拉取失败 → 0/空串
 *  - 文本片段（dragon_tiger_recent / sector_inflow_top / sector_outflow_top / hot_stocks_top）：
 *    缺数据 → undefined，renderHotMoneySummary 据此省略对应分句
 *  - sector_in_industry_tag：标的行业是否落在当日板块流入/流出榜，"主线"|"弱势"|"未上榜"|""
 *  - dragon_tiger_reason：最近一次上榜原因（日涨幅偏离/换手达标等），判断游资炒作 vs 业绩驱动 */
export interface HotMoneyData {
  main_net_today: number;        // 当日主力净流入（元）
  super_net_today: number;       // 当日超大单净流入（元）
  large_net_today: number;       // 当日大单净流入（元）
  northbound_yi: number;         // 全市场北向净流入（亿元）
  northbound_signal: string;     // "inflow"|"outflow"|""（无北向数据则空串）
  dragon_tiger_recent?: string;  // 近 30 天龙虎榜预压缩文本（最近 2 条：日期+净买+换手）
  dragon_tiger_reason?: string;  // 最近一次上榜原因（东财 EXPLANATION，截 20 字）
  sector_inflow_top?: string;    // 当日行业板块流入 top3 名称（"/" 分隔）
  sector_outflow_top?: string;   // 当日行业板块流出 top3 名称（"/" 分隔）
  sector_in_industry_tag: string;// 标的行业归属："主线"|"弱势"|"未上榜"|""
  hot_stocks_top?: string;       // 当日热门股 top3 预压缩文本
}

export interface StockData {
  ticker: string;
  name: string;
  sector: string;
  kline: { pct_5d: number; pct_20d: number; support: number; resistance: number; volatility_20d: number; volume_ratio_5_20: number };
  /** 个股新闻（最多 5 条，含标题/正文摘要/时间）。
   *  旧实现是 string[]（只有标题），现升级为 NewsItem[] 让 LLM 判断时效性 + 标题党。 */
  news: NewsItem[];
  hot_money: HotMoneyData;
  fundamentals: { pe: number; pb: number; rev_q1: number; np_q1: number; industry: string };
  ranker_thesis?: string;
  /** kline.py 预计算的 VPA 量价分析文本（含"顶部背离信号/放量滞涨"等结论）。
   *  undefined = 无 VPA 数据（非 kline 脚本或拉取失败）。 */
  vpa_text?: string;
  /** 新闻时间分层数量（news.py layer_stats）。undefined = 无统计，不阻塞分析。
   *  shallow 用它判断热门/冷门 + 有无突发，是一行文本的成本换密度信号。 */
  news_layer_stats?: NewsLayerStats;
}

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
## 新闻（最近 7 天 top，含时间与正文摘要）
{news_density}{news_bullets}
（注意时效：最近 1-2 天的突发新闻权重高于一周前的旧闻；标题党风险——标题与正文矛盾时以正文为准）
## 资金流向
{hot_money_summary}
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

/** 把 HotMoneyData 渲染成 prompt 里的一行紧凑资金面摘要。
 *
 *  范式对齐 newsDensity（news_layer_stats）：有则一行管道分隔，无则兜底标注。
 *  老实现只塞一个 net_5d 数字（且字段名 bug 恒 0），现把 5 个子源压成一句：
 *  "北向 +2.3亿(inflow) | 当日主力 +1.2亿(超大+0.45亿/大单+0.21亿) | 龙虎榜近30天2次(最近+1.2亿) | 所在行业未在当日主线 | 今日热门:半导体/军工/锂电"
 *
 *  兜底：所有标量全 0 且无任何文本片段 → "(资金数据拉取失败或全空)"，
 *  让 LLM 知道资金面维度无数据（诚实标注缺失，不编造）。 */
function formatYi(yuan: number): string {
  // 元 → 亿元，保留 2 位；0 显示为 0 亿（便于 LLM 区分"无数据"与"净流入 0"）
  return (yuan / 1e8).toFixed(2);
}

function signPrefix(n: number): string {
  return n > 0 ? "+" : "";
}

export function renderHotMoneySummary(h: HotMoneyData): string {
  const parts: string[] = [];

  // 北向资金（全市场外资情绪风向标）
  if (h.northbound_signal) {
    const sig = h.northbound_signal === "inflow" ? "流入" : "流出";
    parts.push(`北向${signPrefix(h.northbound_yi)}${h.northbound_yi.toFixed(2)}亿(${sig})`);
  }

  // 当日主力资金（超大单=机构，大单=游资/大户）
  if (h.main_net_today !== 0 || h.super_net_today !== 0 || h.large_net_today !== 0) {
    const segs = [`当日主力${signPrefix(h.main_net_today)}${formatYi(h.main_net_today)}亿`];
    if (h.super_net_today !== 0) segs.push(`超大单${signPrefix(h.super_net_today)}${formatYi(h.super_net_today)}亿`);
    if (h.large_net_today !== 0) segs.push(`大单${signPrefix(h.large_net_today)}${formatYi(h.large_net_today)}亿`);
    parts.push(segs.join("/"));
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

export function formatAnalystPrompt(d: StockData): string {
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
    .replace("{pct_5d}", String(d.kline.pct_5d))
    .replace("{pct_20d}", String(d.kline.pct_20d))
    .replace("{support}", String(d.kline.support))
    .replace("{resistance}", String(d.kline.resistance))
    .replace("{news_density}", newsDensity)
    .replace("{news_bullets}", newsBullets)
    .replace("{hot_money_summary}", renderHotMoneySummary(d.hot_money))
    .replace("{pe}", String(d.fundamentals.pe))
    .replace("{pb}", String(d.fundamentals.pb))
    .replace("{rev_q1}", String(d.fundamentals.rev_q1))
    .replace("{np_q1}", String(d.fundamentals.np_q1))
    .replace("{ranker_section}", rankerSection);
}

/** 解析 analyst-role 输出。非 JSON / 缺字段返回 null（或填默认值）。 */
export function parseAnalystReport(content: string): AnalystReport | null {
  const obj = extractJson(content);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  return {
    thesis: typeof o.thesis === "string" ? o.thesis : "",
    fitness_score: typeof o.fitness_score === "number" ? o.fitness_score : 0,
    data_freshness: typeof o.data_freshness === "string" ? o.data_freshness : "",
    key_signals: Array.isArray(o.key_signals) ? (o.key_signals as string[]).filter(s => typeof s === "string") : [],
    data_gaps: Array.isArray(o.data_gaps) ? (o.data_gaps as string[]).filter(s => typeof s === "string") : [],
  };
}

/** 从 LLM 输出抽 JSON（先 ```json 代码块，再找平衡花括号）。 */
function extractJson(content: string): unknown | null {
  if (!content) return null;
  const codeBlock = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch { /* fall through */ }
  }
  const start = content.indexOf("{");
  if (start === -1) return null;
  let depth = 0, endIdx = -1, inStr = false, escape = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  if (endIdx === -1) return null;
  try { return JSON.parse(content.slice(start, endIdx + 1)); } catch { return null; }
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
## 资金流向
{hot_money_summary}
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

export function formatRiskPrompt(d: StockData, analyst: AnalystReport): string {
  return RISK_PROMPT_TEMPLATE
    .replace("{ticker}", d.ticker)
    .replace("{name}", d.name)
    .replace("{sector}", d.sector)
    .replace("{pct_5d}", String(d.kline.pct_5d))
    .replace("{pct_20d}", String(d.kline.pct_20d))
    .replace("{volume_ratio_5_20}", String(d.kline.volume_ratio_5_20))
    .replace("{hot_money_summary}", renderHotMoneySummary(d.hot_money))
    .replace("{pe}", String(d.fundamentals.pe))
    .replace("{pb}", String(d.fundamentals.pb))
    .replace("{rev_q1}", String(d.fundamentals.rev_q1))
    .replace("{np_q1}", String(d.fundamentals.np_q1))
    .replace("{vpa_text}", d.vpa_text || "(无 VPA 数据)")
    .replace("{analyst_thesis}", `${analyst.thesis}（fitness ${analyst.fitness_score}）`);
}

export function parseRiskReport(content: string): RiskReport | null {
  const obj = extractJson(content);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const flags = Array.isArray(o.risk_flags) ? (o.risk_flags as unknown[])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map(x => ({
      flag: typeof x.flag === "string" ? x.flag : "",
      severity: (["低", "中", "高"].includes(x.severity as string) ? x.severity : "低") as "低" | "中" | "高",
      detail: typeof x.detail === "string" ? x.detail : "",
    })) : [];
  const risk = ["low", "medium", "high"].includes(o.overall_risk as string) ? o.overall_risk as "low" | "medium" | "high" : "low";
  return {
    risk_flags: flags,
    overall_risk: risk,
    deal_breaker: o.deal_breaker === true,
  };
}

/** 合并 candidate meta + analyst report + risk report → 完整 StockReport。 */
export function buildStockReport(
  meta: CandidateMeta,
  sector: string,
  analyst: AnalystReport,
  risk: RiskReport,
): StockReport {
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
export function buildFallbackReport(
  meta: CandidateMeta,
  sector: string,
  reason: string,
): StockReport {
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
export async function analyzeAll(
  metas: CandidateMeta[],
  dataByTicker: Map<string, StockData>,
  caller: ShallowLlmCaller,
  concurrency: number = 3,
): Promise<StockReport[]> {
  const queue = [...metas];
  const results: Array<StockReport | null> = [];
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const meta = queue.shift()!;
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
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          results.push(meta.is_held ? buildFallbackReport(meta, data.sector, `LLM 调用异常：${reason}`) : null);
        }
      }
    })());
  }
  await Promise.all(workers);
  return results.filter((r): r is StockReport => r !== null);
}
