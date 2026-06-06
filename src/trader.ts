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

function parseNumberField(content: string, fieldRegex: RegExp): number {
  const match = content.match(fieldRegex);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  return isNaN(val) ? 0 : val;
}

/**
 * Parse a price/percentage field from LLM output.
 * Supports: "120元", "**目标价格**：120", "| **目标价格** | 1750 元 |",
 *           "P × 1.08", "5% - 8%", markdown tables, etc.
 * Returns the first parseable number found.
 */
function parseNumericField(content: string, fieldPattern: string): number {
  const escaped = fieldPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Optional suffix after field name (e.g. "目标价格（上行）" or "目标价格/止损价格")
  const suffix = '[^：:|\\n]*?';
  // Pattern 1: inline with colon (e.g. "**目标价格**：120元" or "- **目标价格**: 1750 元")
  const re1 = new RegExp(
    `\\*{0,2}${escaped}${suffix}\\*{0,2}\\s*[：:]\\s*[^\\n]*?([\\d]+(?:[.,]\\d+)?)`,
  );
  // Pattern 2: table cell (e.g. "| **目标价格（上行）** | **1750 元** |")
  const re2 = new RegExp(
    `\\|\\s*\\*{0,2}${escaped}[^|]*?\\*{0,2}\\s*\\|\\s*[^|]*?([\\d]+(?:[.,]\\d+)?)`,
  );
  const match = content.match(re1) || content.match(re2);
  if (!match) return 0;
  const val = parseFloat(match[1].replace(",", ""));
  return isNaN(val) ? 0 : val;
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
    },
    promptsBaseDir
  );

  const result = await callLLM(openaiClient, {
    model: config.models.decision,
    systemPrompt:
      "You are an A-share trader creating specific execution plans based on research decisions.",
    userMessage,
    temperature: 0.3,
    maxTokens: 3000,
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
    target_price: parseNumericField(result.content, "目标价格"),
    stop_loss: parseNumericField(result.content, "止损价格"),
    position_pct: parseNumericField(result.content, "建议仓位"),
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
