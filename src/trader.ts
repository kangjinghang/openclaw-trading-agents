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
  traceLogger: TraceLogger
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
      ticker: "",
      date: "",
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
    target_price: parseNumberField(
      result.content,
      /目标价格\**[：:]\s*([\d,.]+)/
    ),
    stop_loss: parseNumberField(
      result.content,
      /止损价格\**[：:]\s*([\d,.]+)/
    ),
    position_pct: parseNumberField(
      result.content,
      /建议仓位\**[：:]\s*(\d+)/
    ),
    execution_plan: result.content.slice(0, 200),
    entry_signals: parseListSection(result.content, "入场信号"),
    exit_signals: parseListSection(result.content, "退出信号"),
    key_risks: parseListSection(result.content, "关键风险提示"),
    t_plus_1_note: (() => {
      const match = result.content.match(
        /### T\+1 操作约束说明\s*\n([\s\S]*?)(?=\n###|$)/
      );
      return match
        ? match[1].trim()
        : "T+1 制度：当日买入次日才能卖出";
    })(),
  };
}
