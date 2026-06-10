// src/trader.ts

import OpenAI from "openai";
import { callLLM } from "./llm-client";
import { loadAndRender } from "./prompt-loader";
import { TraceLogger } from "./trace-logger";
import {
  TradingAgentsConfig,
  AnalystReport,
  ResearchDecision,
  TradingPlan,
  RiskJudge,
} from "./types";
import * as path from "path";

const SKILLS_DIR = path.resolve(__dirname, "../skills");

/**
 * Format a RiskJudge into a prompt section for the trader (used on revise retry).
 * Emphasizes that hard_constraints MUST be satisfied; the others are advisory.
 */
function buildRiskJudgeText(j: RiskJudge): string {
  const lines: string[] = [
    "## 风控反馈（上一轮计划被要求修订，必须严格遵守以下约束）",
    "",
    `**结论**：${j.verdict}${j.reason ? ` — ${j.reason}` : ""}`,
  ];

  const section = (title: string, items: string[], must: boolean): void => {
    if (items.length === 0) return;
    lines.push("");
    lines.push(`**${title}**${must ? "（必须满足，违反即视为不合规）" : ""}`);
    for (const c of items) lines.push(`- ${c}`);
  };

  section("硬约束", j.hard_constraints, true);
  section("软建议", j.soft_constraints, false);
  section("进场前提", j.execution_preconditions, false);
  section("降风险触发器", j.de_risk_triggers, false);

  return lines.join("\n");
}

/**
 * Parse a price/percentage field from LLM output.
 * Supports: "120元", "**目标价格**：120", "| **目标价格** | 1750 元 |",
 *           "P × 1.08", "5% - 8%", markdown tables, descriptive text with embedded prices.
 * Returns the first parseable number found that looks like a price/percentage (not a date/period).
 */
function parseNumericField(content: string, fieldPattern: string, isPercent: boolean = false): number {
  const escaped = fieldPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffix = '[^：:|\\n]*?';
  // Pattern 1: inline with colon — capture the full value line
  const re1 = new RegExp(
    `\\*{0,2}${escaped}${suffix}\\*{0,2}\\s*[：:]\\s*([^\\n]+)`,
  );
  // Pattern 2: table cell
  const re2 = new RegExp(
    `\\|\\s*\\*{0,2}${escaped}[^|]*?\\*{0,2}\\s*\\|\\s*([^|]+)`,
  );

  const lineMatch = content.match(re1) || content.match(re2);
  if (!lineMatch) return 0;

  const lineText = lineMatch[1];
  // Extract all numbers from the line
  const allNumbers = lineText.match(/\d[\d,.]*/g);
  if (!allNumbers) return 0;

  // Filter out numbers that are time periods (followed by 日/年/月/周/天)
  for (const numStr of allNumbers) {
    const idx = lineText.indexOf(numStr);
    const after = lineText.substring(idx + numStr.length).trimStart();
    // Skip if followed by 日/年/月/周/天 (time period like "200日", "20日/50日")
    if (/^[日年月周天]/.test(after)) continue;
    // For price fields, skip numbers followed by % (percentages are not prices)
    if (!isPercent && /^%/.test(after)) continue;

    const val = parseFloat(numStr.replace(/,/g, ''));
    if (!isNaN(val) && val > 0) return val;
  }
  return 0;
}

/**
 * Parse the total position size (%) from a trader plan.
 *
 * The prompt labels this field "建议仓位" (a Buy-view phrase), so for
 * Sell/Underweight and Hold plans the LLM often emits a direction-appropriate
 * synonym instead — "减仓总量", "减仓比例", "总仓位", "建仓总量". The single-
 * label parser missed those → position_pct fell back to 0, which also silently
 * defeated the risk cap-binding downstream (a cap of N% is never < 0).
 * Regression: the 600600 Sell run wrote "减仓总量 ... 30%" yet stored
 * position_pct=0.
 *
 * Tries the canonical label first; if that yields nothing, falls back through
 * the synonyms. Returns 0 only when no total-position value is present
 * anywhere. Sub-batch tranche labels (第一批/第二批/分批/加仓) are never
 * synonyms, so a per-tranche number is never mistaken for the total.
 */
export function parsePositionPct(content: string): number {
  let v = parseNumericField(content, "建议仓位", true);
  if (v > 0) return v;
  for (const label of ["减仓总量", "减仓比例", "总仓位", "建仓总量"]) {
    v = parseNumericField(content, label, true);
    if (v > 0) return v;
  }
  return 0;
}

function parseListSection(content: string, header: string): string[] {
  // Allow an optional numeric prefix ("### 3.") and trailing parenthetical
  // ("（triggers — …）") on the header so real LLM output (which numbers
  // sections per the prompt) still matches. Best-effort fallback only —
  // the TRADER_PLAN JSON block is the primary parse path.
  const regex = new RegExp(
    `### \\d*[\\.、]?\\s*${header}[^\\n]*\\n([\\s\\S]*?)(?=\\n###|\\n<!-- |$)`
  );
  const match = content.match(regex);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((l) => l.replace(/^\d+\.\s*/, "").replace(/^-\s*/, "").trim())
    .filter((l) => l.length > 0 && !l.includes("|")); // skip markdown table rows
}

/**
 * Parse a `<!-- TRADER_PLAN: {...} -->` JSON block from trader output.
 * Returns null on: missing block, malformed JSON, or non-object payload.
 * Missing optional arrays are coerced to empty defaults so partial LLM
 * output is still usable. Mirrors the VERDICT/DEBATE_STATE/RISK_JUDGE
 * structured-output protocol — decouples signal parsing from the exact
 * markdown heading format the LLM happens to emit.
 */
export function parseTraderPlan(content: string): {
  entry_signals: string[];
  exit_signals: string[];
  invalidations: string[];
  key_risks: string[];
} | null {
  const regex = /<!--\s*TRADER_PLAN:\s*(\{.*?\})\s*-->/s;
  const match = content.match(regex);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const coerceStrArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  return {
    entry_signals: coerceStrArray(obj.entry_signals),
    exit_signals: coerceStrArray(obj.exit_signals),
    invalidations: coerceStrArray(obj.invalidations),
    key_risks: coerceStrArray(obj.key_risks),
  };
}

export async function runTrader(
  researchDecision: ResearchDecision,
  analystReports: AnalystReport[],
  qualitySummary: string,
  config: TradingAgentsConfig,
  openaiClient: OpenAI,
  traceLogger: TraceLogger,
  ticker?: string,
  date?: string,
  riskJudge?: RiskJudge
): Promise<TradingPlan> {
  const promptsBaseDir = path.join(
    SKILLS_DIR,
    "trading-analysis",
    "prompts"
  );

  const reportsText = analystReports
    .map((r) => `## ${r.role} 分析师\n${r.content}`)
    .join("\n\n");

  const decisionText = `方向：${researchDecision.direction}\n信心：${researchDecision.confidence}\n理由：${researchDecision.reasoning}\n辩论焦点：${researchDecision.key_debate_points.join("、")}`;

  const userMessage = loadAndRender(
    "debate/trader.md",
    {
      ticker: ticker || "",
      date: date || "",
      research_decision: decisionText,
      analyst_reports: reportsText,
      quality_summary: qualitySummary,
      risk_judge: riskJudge ? buildRiskJudgeText(riskJudge) : "",
    },
    promptsBaseDir
  );

  const result = await callLLM(openaiClient, {
    model: config.models.decision,
    systemPrompt:
      "You are an A-share trader creating specific execution plans based on research decisions.",
    userMessage,
    temperature: 0.3,
    phase: "trader",
    role: "trader",
    traceLogger,
  });

  const direction = researchDecision.direction;
  // Prefer the structured TRADER_PLAN block; fall back to list-section parsing.
  const plan = parseTraderPlan(result.content);

  return {
    direction:
      direction === "Overweight"
        ? "Buy"
        : direction === "Underweight"
        ? "Sell"
        : direction,
    target_price: parseNumericField(result.content, "目标价格", false),
    stop_loss: parseNumericField(result.content, "止损价格", false),
    position_pct: parsePositionPct(result.content),
    execution_plan: result.content.slice(0, 3000),
    entry_signals: plan?.entry_signals.length ? plan.entry_signals : parseListSection(result.content, "入场信号"),
    exit_signals: plan?.exit_signals.length ? plan.exit_signals : parseListSection(result.content, "退出信号"),
    invalidations: plan?.invalidations.length ? plan.invalidations : parseListSection(result.content, "失效条件"),
    key_risks: plan?.key_risks.length ? plan.key_risks : parseListSection(result.content, "关键风险提示"),
    t_plus_1_note: (() => {
      const match = result.content.match(
        /### [T＋+]1 操作约束说明\s*\n([\s\S]*?)(?=\n###|$)/
      );
      return match
        ? match[1].trim()
        : "T+1 制度：当日买入次日才能卖出";
    })(),
  };
}
