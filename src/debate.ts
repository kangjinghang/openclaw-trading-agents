// src/debate.ts

import OpenAI from "openai";
import { callLLM } from "./llm-client";
import { loadAndRender } from "./prompt-loader";
import { TraceLogger } from "./trace-logger";
import {
  TradingAgentsConfig,
  AnalystReport,
  DebateResult,
  DebateRound,
  DebateClaim,
} from "./types";
import * as path from "path";

const SKILLS_DIR = path.resolve(__dirname, "../skills");

/**
 * Parse claims from LLM debate output.
 */
function parseClaims(content: string, side: "bull" | "bear"): DebateClaim[] {
  const claims: DebateClaim[] = [];
  const regex = /\*\*论点 ID\*\*：(BULL|BEAR)-(\d+)\s*\n[\s\S]*?\*\*核心观点\*\*[：:]\s*(.+)\n[\s\S]*?\*\*支撑证据\*\*[：:]\s*(.+)\n[\s\S]*?\*\*信心水平\*\*[：:]\s*(高|中|低)/g;

  let match;
  while ((match = regex.exec(content)) !== null) {
    const id = `${match[1]}-${match[2]}`;
    const confidenceMap: Record<string, number> = { "高": 0.9, "中": 0.6, "低": 0.3 };
    claims.push({
      id,
      side,
      topic: match[3].trim(),
      evidence: match[4].trim(),
      confidence: confidenceMap[match[5]] ?? 0.5,
    });
  }
  return claims;
}

/**
 * Extract summary section from debate output.
 */
function extractSummary(content: string): string {
  const summaryRegex = /### (?:论据|风险)总结\s*\n([\s\S]*?)(?=\n<!-- VERDICT|$)/;
  const match = content.match(summaryRegex);
  return match ? match[1].trim() : content.slice(-200).trim();
}

/**
 * Run multi-round Bull<->Bear debate over analyst reports.
 */
export async function runBullBearDebate(
  analystReports: AnalystReport[],
  config: TradingAgentsConfig,
  openaiClient: OpenAI,
  traceLogger: TraceLogger
): Promise<DebateResult> {
  const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");

  const reportsText = analystReports
    .map((r) => `## ${r.role} 分析师\n${r.content}`)
    .join("\n\n");

  const rounds: DebateRound[] = [];
  let totalTokens = 0;
  let totalCostUsd = 0;
  let bullSummary = "";
  let bearSummary = "";

  let lastBearClaims: DebateClaim[] = [];

  for (let round = 1; round <= config.debate_rounds; round++) {
    // Bull's turn
    const bullOpponentText = lastBearClaims.length > 0
      ? `## 对方（空头）论点\n\n${lastBearClaims.map((c) => `- [${c.id}] ${c.topic}：${c.evidence}`).join("\n")}`
      : "";

    const bullMessage = loadAndRender(
      "debate/bull_researcher.md",
      { ticker: "", date: "", analyst_reports: reportsText, opponent_claims: bullOpponentText },
      promptsBaseDir
    );

    const bullResult = await callLLM(openaiClient, {
      model: config.models.debater,
      systemPrompt: "You are a bullish A-share researcher constructing evidence-based bull arguments.",
      userMessage: bullMessage,
      temperature: 0.5,
      phase: "debate",
      role: "bull",
      traceLogger,
    });

    totalTokens += bullResult.usage.total_tokens;
    totalCostUsd += bullResult.costUsd;

    const bullClaims = parseClaims(bullResult.content, "bull");
    const bullSummaryText = extractSummary(bullResult.content);

    // Bear's turn
    const bearOpponentText = bullClaims.length > 0
      ? `## 对方（多头）论点\n\n${bullClaims.map((c) => `- [${c.id}] ${c.topic}：${c.evidence}`).join("\n")}`
      : "";

    const bearMessage = loadAndRender(
      "debate/bear_researcher.md",
      { ticker: "", date: "", analyst_reports: reportsText, opponent_claims: bearOpponentText },
      promptsBaseDir
    );

    const bearResult = await callLLM(openaiClient, {
      model: config.models.debater,
      systemPrompt: "You are a bearish A-share researcher identifying risks and countering bull arguments.",
      userMessage: bearMessage,
      temperature: 0.5,
      phase: "debate",
      role: "bear",
      traceLogger,
    });

    totalTokens += bearResult.usage.total_tokens;
    totalCostUsd += bearResult.costUsd;

    const bearClaims = parseClaims(bearResult.content, "bear");
    const bearSummaryText = extractSummary(bearResult.content);

    rounds.push({ round, bull_claims: bullClaims, bear_claims: bearClaims });
    lastBearClaims = bearClaims;
    bullSummary = bullSummaryText;
    bearSummary = bearSummaryText;
  }

  return { rounds, bull_summary: bullSummary, bear_summary: bearSummary, total_tokens: totalTokens, total_cost_usd: totalCostUsd };
}
