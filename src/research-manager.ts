// src/research-manager.ts

import OpenAI from "openai";
import { callLLM, parseVerdict } from "./llm-client";
import { loadAndRender } from "./prompt-loader";
import { TraceLogger } from "./trace-logger";
import {
  TradingAgentsConfig,
  AnalystReport,
  DebateResult,
  ResearchDecision,
} from "./types";
import * as path from "path";

const SKILLS_DIR = path.resolve(__dirname, "../skills");

function parseScores(content: string): { bull_score: number; bear_score: number } {
  const bullMatch = content.match(/\*\*多头得分\*\*[：:]\s*(\d+)/);
  const bearMatch = content.match(/\*\*空头得分\*\*[：:]\s*(\d+)/);
  return {
    bull_score: bullMatch ? parseInt(bullMatch[1], 10) : 50,
    bear_score: bearMatch ? parseInt(bearMatch[1], 10) : 50,
  };
}

function parseConfidence(content: string): number {
  const match = content.match(/\*\*信心水平\*\*[：:]\s*([\d.]+)/);
  return match ? parseFloat(match[1]) : 0.5;
}

function parseDebatePoints(content: string): string[] {
  const sectionMatch = content.match(/### 关键辩论焦点\s*\n([\s\S]*?)(?=\n###|\n<!-- VERDICT|$)/);
  if (!sectionMatch) return [];
  return sectionMatch[1].split("\n").map((l) => l.replace(/^\d+\.\s*/, "").trim()).filter(Boolean);
}

function parse5TierDirection(raw: string): ResearchDecision["direction"] {
  const n = raw.toLowerCase().trim();
  if (n === "buy" || n === "买入") return "Buy";
  if (n === "overweight" || n === "增持") return "Overweight";
  if (n === "hold" || n === "持有" || n === "中性") return "Hold";
  if (n === "underweight" || n === "减持") return "Underweight";
  if (n === "sell" || n === "卖出") return "Sell";
  return "Hold";
}

export async function runResearchManager(
  analystReports: AnalystReport[],
  debate: DebateResult,
  config: TradingAgentsConfig,
  openaiClient: OpenAI,
  traceLogger: TraceLogger
): Promise<ResearchDecision> {
  const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");

  const reportsText = analystReports
    .map((r) => `## ${r.role} 分析师\n${r.content}`)
    .join("\n\n");

  const debateRoundsText = debate.rounds
    .map((r) => {
      const bullText = r.bull_claims.map((c) => `[${c.id}] ${c.topic}（信心 ${c.confidence}）`).join("; ");
      const bearText = r.bear_claims.map((c) => `[${c.id}] ${c.topic}（信心 ${c.confidence}）`).join("; ");
      return `### Round ${r.round}\n多头论点：${bullText}\n空头论点：${bearText}`;
    })
    .join("\n\n");

  const userMessage = loadAndRender(
    "debate/research_manager.md",
    {
      ticker: "",
      date: "",
      analyst_reports: reportsText,
      debate_rounds: debateRoundsText,
      bull_summary: debate.bull_summary,
      bear_summary: debate.bear_summary,
    },
    promptsBaseDir
  );

  const result = await callLLM(openaiClient, {
    model: config.models.decision,
    systemPrompt: "You are a research manager evaluating Bull↔Bear debate quality and making trading direction decisions.",
    userMessage,
    temperature: 0.3,
    maxTokens: 3000,
    phase: "research",
    role: "research_manager",
    traceLogger,
  });

  const verdict = parseVerdict(result.content);
  const scores = parseScores(result.content);
  const confidence = parseConfidence(result.content);
  const keyPoints = parseDebatePoints(result.content);

  return {
    direction: parse5TierDirection(verdict?.direction || ""),
    confidence,
    bull_score: scores.bull_score,
    bear_score: scores.bear_score,
    reasoning: verdict?.reason || "",
    key_debate_points: keyPoints,
    verdict: verdict || { direction: "Hold", reason: "无法解析结论" },
  };
}
