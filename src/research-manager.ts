// src/research-manager.ts

import OpenAI from "openai";
import { callLLM, parseVerdict, parseResearchVerdict } from "./llm-client";
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
  // Match with or without markdown bold markers
  const bullMatch = content.match(/\*{0,2}多头得分\*{0,2}[：:]\s*(\d+)/) ||
                    content.match(/bull.?score[：:]\s*(\d+)/i);
  const bearMatch = content.match(/\*{0,2}空头得分\*{0,2}[：:]\s*(\d+)/) ||
                    content.match(/bear.?score[：:]\s*(\d+)/i);
  return {
    bull_score: bullMatch ? parseInt(bullMatch[1], 10) : 50,
    bear_score: bearMatch ? parseInt(bearMatch[1], 10) : 50,
  };
}

function parseConfidence(content: string): number {
  const match = content.match(/\*{0,2}信心水平\*{0,2}[：:]\s*([\d.]+)/) ||
                content.match(/confidence[：:]\s*([\d.]+)/i);
  return match ? parseFloat(match[1]) : 0.5;
}

function parseDebatePoints(content: string): string[] {
  const sectionMatch = content.match(/### 关键辩论焦点\s*\n([\s\S]*?)(?=\n###|\n<!-- VERDICT|$)/);
  if (!sectionMatch) return [];
  return sectionMatch[1].split("\n").map((l) => l.replace(/^\d+\.\s*/, "").trim()).filter(Boolean);
}

function parse5TierDirection(raw: string): ResearchDecision["direction"] {
  // Take the first option if LLM outputs "看多|看空|中性" style multi-choice
  const firstOption = raw.split("|")[0].trim();
  const n = firstOption.toLowerCase();
  if (n === "buy" || n === "买入" || n === "看多") return "Buy";
  if (n === "overweight" || n === "增持") return "Overweight";
  if (n === "hold" || n === "持有" || n === "中性") return "Hold";
  if (n === "underweight" || n === "减持") return "Underweight";
  if (n === "sell" || n === "卖出" || n === "看空") return "Sell";
  return "Hold";
}

export async function runResearchManager(
  analystReports: AnalystReport[],
  debate: DebateResult,
  qualitySummary: string,
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
      quality_summary: qualitySummary,
    },
    promptsBaseDir
  );

  const result = await callLLM(openaiClient, {
    model: config.models.decision_deep || config.models.decision,
    systemPrompt: "You are a research manager evaluating Bull↔Bear debate quality and making trading direction decisions.",
    userMessage,
    temperature: 0.3,
    phase: "research",
    role: "research_manager",
    traceLogger,
  });

  // Structured-first: prefer the numeric extensions the prompt now asks the
  // research manager to embed in its VERDICT block (bull_score/bear_score/
  // confidence). These are authoritative; the free-text regexes (parseScores/
  // parseConfidence) are fallback for older/uncooperative model output.
  //
  // Previously direction came from the structured VERDICT while scores/
  // confidence were regex-scraped from prose — two parse paths that could
  // contradict (688662 regression: VERDICT Sell but scores 50/50). Worse, the
  // regexes defaulted silently to 50/50 + 0.5 on miss, masking a parse failure
  // as a genuine tie. Now: structured values win, fallback records a warning.
  const verdict = parseVerdict(result.content);
  const rv = parseResearchVerdict(result.content);
  const keyPoints = parseDebatePoints(result.content);

  let bull_score: number;
  let bear_score: number;
  let confidence: number;

  const usedStructuredScores = rv?.bull_score !== undefined && rv?.bear_score !== undefined;
  if (usedStructuredScores) {
    bull_score = rv!.bull_score!;
    bear_score = rv!.bear_score!;
  } else {
    // Fallback: regex scrape from prose. Default 50/50 used to be silent — now
    // surfaced so a parse failure isn't indistinguishable from a real tie.
    const scores = parseScores(result.content);
    bull_score = scores.bull_score;
    bear_score = scores.bear_score;
    traceLogger.recordWarning({
      phase: "research",
      fn: "parseScores",
      detail: `VERDICT 块缺 bull_score/bear_score 数值字段，回退正则解析（bull=${bull_score}, bear=${bear_score}）`,
      severity: "warn",
    });
  }

  if (rv?.confidence !== undefined) {
    confidence = rv.confidence;
  } else {
    confidence = parseConfidence(result.content);
    traceLogger.recordWarning({
      phase: "research",
      fn: "parseConfidence",
      detail: `VERDICT 块缺 confidence 数值字段，回退正则解析（confidence=${confidence}）`,
      severity: "warn",
    });
  }
  // Defensive clamp on both paths: parseConfidence's regex ([\d.]+) can capture
  // out-of-range values (e.g. 100 from a 0-100 confusion). Structured path is
  // already clamped by parseResearchVerdict; this makes the fallback path agree.
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    direction: parse5TierDirection(verdict?.direction || ""),
    confidence,
    bull_score,
    bear_score,
    reasoning: verdict?.reason || "",
    key_debate_points: keyPoints,
    verdict: verdict || { direction: "Hold", reason: "无法解析结论" },
  };
}
