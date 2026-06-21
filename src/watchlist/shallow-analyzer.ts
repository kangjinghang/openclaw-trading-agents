import type { AnalystReport } from "./rebalance-types";

export interface StockData {
  ticker: string;
  name: string;
  sector: string;
  kline: { pct_5d: number; pct_20d: number; support: number; resistance: number };
  news: string[];
  hot_money: { net_5d: number };
  fundamentals: { pe: number; pb: number; rev_q1: number; np_q1: number };
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
