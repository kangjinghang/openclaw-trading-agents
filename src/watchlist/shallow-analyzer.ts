import type { AnalystReport, RiskFlag, RiskReport, StockReport } from "./rebalance-types";
import type { CandidateMeta } from "./candidate-selector";

export type ShallowLlmCaller = (input: {
  role: "analyst" | "risk";
  data: StockData;
  analyst?: AnalystReport;
}) => Promise<string>;

export interface StockData {
  ticker: string;
  name: string;
  sector: string;
  kline: { pct_5d: number; pct_20d: number; support: number; resistance: number; volatility_20d: number };
  news: string[];
  hot_money: { net_5d: number };
  fundamentals: { pe: number; pb: number; rev_q1: number; np_q1: number; industry: string };
  ranker_thesis?: string;
}

const ANALYST_PROMPT_TEMPLATE = `# 角色
你是 A 股证券分析师，对单只股票做综合评估。

# 任务
基于以下数据，输出 thesis + fitness + 关键信号。要求 reason 含具体词（产品/客户/数据/业务节点），
禁止模糊词（共振/资金追捧/活跃/爆发力强）。

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

export function formatAnalystPrompt(d: StockData): string {
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
你是 A 股风险分析师，识别单只股票的关键风险。

# 任务
基于以下数据 + analyst 给的 thesis，输出风险清单。不要做 Buy/Sell 判断。

# 股票
{ticker} {name}（行业：{sector}）

# 数据
## K 线 + 资金 + 基本面
（同 analyst-role 输入）

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

/** 对所有候选/持仓股跑 analyst + risk 双 call（单股内串行，跨股并发限制）。
 *  单股失败（LLM 异常或数据缺失）跳过，rebalancer 看不到该股。
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
          results.push(null);
          continue;
        }
        try {
          const analystContent = await caller({ role: "analyst", data });
          const analyst = parseAnalystReport(analystContent);
          if (!analyst) {
            results.push(null);
            continue;
          }
          const riskContent = await caller({ role: "risk", data, analyst });
          const risk = parseRiskReport(riskContent);
          if (!risk) {
            results.push(null);
            continue;
          }
          results.push(buildStockReport(meta, data.sector, analyst, risk));
        } catch {
          results.push(null);
        }
      }
    })());
  }
  await Promise.all(workers);
  return results.filter((r): r is StockReport => r !== null);
}
