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
  DebateStatePayload,
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
 * Parse a `<!-- DEBATE_STATE: {...} -->` JSON block from LLM debate output.
 * Returns null on: missing block, malformed JSON, or non-object payload.
 * Missing optional fields are coerced to empty defaults so partial LLM output
 * is still usable.
 */
export function parseDebateState(content: string): DebateStatePayload | null {
  const regex = /<!--\s*DEBATE_STATE:\s*(\{.*?\})\s*-->/s;
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

  const newClaims = Array.isArray(obj.new_claims)
    ? obj.new_claims
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as Record<string, unknown>).claim === "string")
        .map((c) => ({
          claim: c.claim as string,
          evidence: Array.isArray(c.evidence)
            ? c.evidence.filter((e): e is string => typeof e === "string")
            : [],
          confidence: typeof c.confidence === "number" ? c.confidence : 0.5,
        }))
    : [];

  return {
    responded_claim_ids: coerceStrArray(obj.responded_claim_ids),
    new_claims: newClaims,
    resolved_claim_ids: coerceStrArray(obj.resolved_claim_ids),
    unresolved_claim_ids: coerceStrArray(obj.unresolved_claim_ids),
    next_focus_claim_ids: coerceStrArray(obj.next_focus_claim_ids),
    round_summary: typeof obj.round_summary === "string" ? obj.round_summary : "",
    round_goal: typeof obj.round_goal === "string" ? obj.round_goal : "",
  };
}

/**
 * Format the list of claim IDs the current debater must address this turn.
 */
function buildFocusText(ids: string[], registryById: Map<string, DebateClaim>): string {
  const claims = ids.map((id) => registryById.get(id)).filter((c): c is DebateClaim => !!c);
  if (claims.length === 0) return "（无强制回应项，可自由展开最强论点）";
  const lines = claims.map(
    (c) => `- [${c.id}]（${c.side === "bull" ? "多头" : "空头"}，信心 ${c.confidence}）${c.topic}\n  证据：${c.evidence}`
  );
  return `### 本轮必须回应的焦点 claim\n${lines.join("\n")}`;
}

/**
 * Format the list of still-unresolved claims (the crux of disagreement).
 */
function buildUnresolvedText(ids: string[], registryById: Map<string, DebateClaim>): string {
  const claims = ids.map((id) => registryById.get(id)).filter((c): c is DebateClaim => !!c);
  if (claims.length === 0) return "（暂无未解决 claim）";
  const lines = claims.map(
    (c) => `- [${c.id}]（${c.side === "bull" ? "多头" : "空头"}）${c.topic}`
  );
  return `### 仍未解决的 claim\n${lines.join("\n")}`;
}

interface DebateRegistry {
  claims: DebateClaim[];
  byId: Map<string, DebateClaim>;
  resolvedIds: Set<string>;
  unresolvedIds: Set<string>;
  counter: { bull: number; bear: number };
}

/**
 * Apply a parsed DEBATE_STATE payload to the global registry: register new
 * claims with stable counter-based IDs, update statuses, and compute the
 * focus IDs for the next turn.
 */
function processDebateState(
  state: DebateStatePayload,
  side: "bull" | "bear",
  round: number,
  reg: DebateRegistry
): { newClaims: DebateClaim[]; nextFocus: string[] } {
  // 1. Mark responded opponent claims as addressed
  for (const id of state.responded_claim_ids) {
    const c = reg.byId.get(id);
    if (c && c.status === "open") {
      c.status = "addressed";
      c.responded_by = side;
    }
  }

  // 2. Mark resolved claims (resolved wins over unresolved)
  for (const id of state.resolved_claim_ids) {
    const c = reg.byId.get(id);
    if (c) c.status = "resolved";
    reg.resolvedIds.add(id);
    reg.unresolvedIds.delete(id);
  }

  // 3. Mark unresolved claims (only if not already resolved)
  for (const id of state.unresolved_claim_ids) {
    if (reg.resolvedIds.has(id)) continue;
    const c = reg.byId.get(id);
    if (c && c.status !== "resolved") c.status = "unresolved";
    reg.unresolvedIds.add(id);
  }

  // 4. Register new claims with global counter IDs (override LLM IDs)
  const newClaims: DebateClaim[] = [];
  for (const nc of state.new_claims) {
    reg.counter[side]++;
    const id = `${side.toUpperCase()}-${reg.counter[side]}`;
    const claim: DebateClaim = {
      id,
      side,
      topic: nc.claim,
      evidence: nc.evidence.length > 0 ? nc.evidence.join("；") : "（无证据）",
      confidence: nc.confidence,
      status: "open",
      round,
    };
    reg.claims.push(claim);
    reg.byId.set(id, claim);
    newClaims.push(claim);
  }

  // 5. Compute next focus: explicit suggestion, else top-2 unresolved by confidence
  let nextFocus = state.next_focus_claim_ids.filter((id) => reg.byId.has(id));
  if (nextFocus.length === 0) {
    nextFocus = [...reg.unresolvedIds]
      .map((id) => reg.byId.get(id))
      .filter((c): c is DebateClaim => !!c)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 2)
      .map((c) => c.id);
  }

  return { newClaims, nextFocus };
}

/**
 * Run multi-round Bull<->Bear debate over analyst reports.
 *
 * Each turn prefers the structured `<!-- DEBATE_STATE: {...} -->` payload
 * (state-machine mode: stable claim IDs, resolved/unresolved tracking, focus
 * propagation). When absent, it falls back to `parseClaims()` regex parsing
 * with no state update, preserving legacy behavior.
 */
export async function runBullBearDebate(
  analystReports: AnalystReport[],
  qualitySummary: string,
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

  // DEBATE_STATE tracking
  const registry: DebateRegistry = {
    claims: [],
    byId: new Map(),
    resolvedIds: new Set(),
    unresolvedIds: new Set(),
    counter: { bull: 0, bear: 0 },
  };
  let focusIds: string[] = [];
  let lastRoundSummary = "";
  let lastRoundGoal = "";

  let lastBearClaims: DebateClaim[] = [];

  for (let round = 1; round <= config.debate_rounds; round++) {
    const resolvedThisRound = new Set<string>();
    let bullRespondedIds: string[] = [];
    let bearRespondedIds: string[] = [];

    // ── Bull's turn ──────────────────────────────────────────────
    const bullOpponentText = lastBearClaims.length > 0
      ? `## 对方（空头）论点\n\n${lastBearClaims.map((c) => `- [${c.id}] ${c.topic}：${c.evidence}`).join("\n")}`
      : "";
    const bullFocusText = buildFocusText(focusIds, registry.byId);
    const bullUnresolvedText = buildUnresolvedText([...registry.unresolvedIds], registry.byId);

    const bullMessage = loadAndRender(
      "debate/bull_researcher.md",
      {
        ticker: "",
        date: "",
        analyst_reports: reportsText,
        opponent_claims: bullOpponentText,
        quality_summary: qualitySummary,
        focus_claims: bullFocusText,
        unresolved_claims: bullUnresolvedText,
        round_summary: lastRoundSummary,
        round_goal: lastRoundGoal,
      },
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

    const bullState = parseDebateState(bullResult.content);
    let bullClaims: DebateClaim[];
    if (bullState) {
      const processed = processDebateState(bullState, "bull", round, registry);
      bullClaims = processed.newClaims;
      bullRespondedIds = bullState.responded_claim_ids;
      bullState.resolved_claim_ids.forEach((id) => resolvedThisRound.add(id));
      focusIds = processed.nextFocus;
      if (bullState.round_summary) lastRoundSummary = bullState.round_summary;
      if (bullState.round_goal) lastRoundGoal = bullState.round_goal;
    } else {
      bullClaims = parseClaims(bullResult.content, "bull");
    }
    const bullSummaryText = extractSummary(bullResult.content);

    // ── Bear's turn ──────────────────────────────────────────────
    const bearOpponentText = bullClaims.length > 0
      ? `## 对方（多头）论点\n\n${bullClaims.map((c) => `- [${c.id}] ${c.topic}：${c.evidence}`).join("\n")}`
      : "";
    const bearFocusText = buildFocusText(focusIds, registry.byId);
    const bearUnresolvedText = buildUnresolvedText([...registry.unresolvedIds], registry.byId);

    const bearMessage = loadAndRender(
      "debate/bear_researcher.md",
      {
        ticker: "",
        date: "",
        analyst_reports: reportsText,
        opponent_claims: bearOpponentText,
        quality_summary: qualitySummary,
        focus_claims: bearFocusText,
        unresolved_claims: bearUnresolvedText,
        round_summary: lastRoundSummary,
        round_goal: lastRoundGoal,
      },
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

    const bearState = parseDebateState(bearResult.content);
    let bearClaims: DebateClaim[];
    if (bearState) {
      const processed = processDebateState(bearState, "bear", round, registry);
      bearClaims = processed.newClaims;
      bearRespondedIds = bearState.responded_claim_ids;
      bearState.resolved_claim_ids.forEach((id) => resolvedThisRound.add(id));
      focusIds = processed.nextFocus;
      if (bearState.round_summary) lastRoundSummary = bearState.round_summary;
      if (bearState.round_goal) lastRoundGoal = bearState.round_goal;
    } else {
      bearClaims = parseClaims(bearResult.content, "bear");
    }
    const bearSummaryText = extractSummary(bearResult.content);

    rounds.push({
      round,
      bull_claims: bullClaims,
      bear_claims: bearClaims,
      bull_responded_ids: bullRespondedIds.length > 0 ? bullRespondedIds : undefined,
      bear_responded_ids: bearRespondedIds.length > 0 ? bearRespondedIds : undefined,
      resolved_ids: resolvedThisRound.size > 0 ? [...resolvedThisRound] : undefined,
      unresolved_ids: registry.unresolvedIds.size > 0 ? [...registry.unresolvedIds] : undefined,
      next_focus_ids: focusIds.length > 0 ? focusIds : undefined,
      round_summary: lastRoundSummary || undefined,
      round_goal: lastRoundGoal || undefined,
    });

    lastBearClaims = bearClaims;
    bullSummary = bullSummaryText;
    bearSummary = bearSummaryText;
  }

  // Compute convergence score based on rounds data
  const lastRound = rounds[rounds.length - 1];
  const totalUnresolved = lastRound?.unresolved_ids?.length || 0;
  const totalResolved = rounds.reduce((sum, r) => sum + (r.resolved_ids?.length || 0), 0);
  const totalClaims = totalResolved + totalUnresolved;

  // Base convergence: ratio of resolved claims
  const baseConvergence = totalClaims > 0 ? totalResolved / totalClaims : 0.5;

  // Divergence penalty: if last round has more unresolved than first round
  let divergencePenalty = 0;
  if (rounds.length >= 2) {
    const firstRoundUnresolved = rounds[0].unresolved_ids?.length || 0;
    const lastRoundUnresolved = lastRound?.unresolved_ids?.length || 0;
    if (lastRoundUnresolved > firstRoundUnresolved) {
      divergencePenalty = Math.min(0.3, (lastRoundUnresolved - firstRoundUnresolved) * 0.1);
    }
  }

  const convergenceScore = Math.max(0, Math.min(1, baseConvergence - divergencePenalty));

  // Build resolved points list
  const resolvedPoints = rounds
    .flatMap(r => r.resolved_ids || [])
    .map(id => {
      const claim = registry.byId.get(id);
      return claim ? `${claim.id}: ${claim.topic}` : id;
    });

  return {
    rounds,
    bull_summary: bullSummary,
    bear_summary: bearSummary,
    convergence_score: convergenceScore,
    resolved_points: resolvedPoints,
    total_tokens: totalTokens,
    total_cost_usd: totalCostUsd,
  };
}
