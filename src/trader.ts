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
} from "./types";
import * as path from "path";

const SKILLS_DIR = path.resolve(__dirname, "../skills");

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

function parseListSection(content: string, header: string): string[] {
  const regex = new RegExp(
    `### ${header}[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n###|\\n<!-- VERDICT|$)`
  );
  const match = content.match(regex);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((l) => l.replace(/^\d+\.\s*/, "").replace(/^-\s*/, "").trim())
    .filter((l) => l.length > 0);
}

export async function runTrader(
  researchDecision: ResearchDecision,
  analystReports: AnalystReport[],
  qualitySummary: string,
  config: TradingAgentsConfig,
  openaiClient: OpenAI,
  traceLogger: TraceLogger,
  ticker?: string,
  date?: string
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

  return {
    direction:
      direction === "Overweight"
        ? "Buy"
        : direction === "Underweight"
        ? "Sell"
        : direction,
    target_price: parseNumericField(result.content, "目标价格", false),
    stop_loss: parseNumericField(result.content, "止损价格", false),
    position_pct: parseNumericField(result.content, "建议仓位", true),
    execution_plan: result.content.slice(0, 3000),
    entry_signals: parseListSection(result.content, "入场信号"),
    exit_signals: parseListSection(result.content, "退出信号"),
    key_risks: parseListSection(result.content, "关键风险提示"),
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
