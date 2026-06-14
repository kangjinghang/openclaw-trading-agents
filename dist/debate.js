"use strict";
// src/debate.ts
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractSummary = extractSummary;
exports.parseDebateState = parseDebateState;
exports.runBullBearDebate = runBullBearDebate;
const llm_client_1 = require("./llm-client");
const prompt_loader_1 = require("./prompt-loader");
const path = __importStar(require("path"));
const SKILLS_DIR = path.resolve(__dirname, "../skills");
/**
 * Parse claims from LLM debate output.
 */
function parseClaims(content, side) {
    const claims = [];
    const regex = /\*\*论点 ID\*\*：(BULL|BEAR)-(\d+)\s*\n[\s\S]*?\*\*核心观点\*\*[：:]\s*(.+)\n[\s\S]*?\*\*支撑证据\*\*[：:]\s*(.+)\n[\s\S]*?\*\*信心水平\*\*[：:]\s*(高|中|低)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        const id = `${match[1]}-${match[2]}`;
        const confidenceMap = { "高": 0.9, "中": 0.6, "低": 0.3 };
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
function extractSummary(content) {
    const summaryRegex = /### (?:论据|风险)总结\s*\n([\s\S]*?)(?=\n<!--|$)/;
    const match = content.match(summaryRegex);
    if (match)
        return match[1].trim();
    // Fallback: strip HTML comment blocks (DEBATE_STATE / VERDICT / etc.) before
    // taking the tail, otherwise JSON-block remnants can pollute the summary
    // when the LLM doesn't follow the "### 论据总结" convention.
    const stripped = content.replace(/<!--[\s\S]*?-->/g, "").trim();
    return stripped.slice(-200).trim();
}
/**
 * Parse a `<!-- DEBATE_STATE: {...} -->` JSON block from LLM debate output.
 * Returns null on: missing block, malformed JSON, or non-object payload.
 * Missing optional fields are coerced to empty defaults so partial LLM output
 * is still usable.
 */
function parseDebateState(content) {
    const regex = /<!--\s*DEBATE_STATE:\s*(\{.*?\})\s*-->/s;
    const match = content.match(regex);
    if (!match)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(match[1]);
    }
    catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null;
    }
    const obj = parsed;
    const coerceStrArray = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    const newClaims = Array.isArray(obj.new_claims)
        ? obj.new_claims
            .filter((c) => !!c && typeof c === "object" && typeof c.claim === "string")
            .map((c) => ({
            claim: c.claim,
            evidence: Array.isArray(c.evidence)
                ? c.evidence.filter((e) => typeof e === "string")
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
function buildFocusText(ids, registryById) {
    const claims = ids.map((id) => registryById.get(id)).filter((c) => !!c);
    if (claims.length === 0)
        return "（无强制回应项，可自由展开最强论点）";
    const lines = claims.map((c) => `- [${c.id}]（${c.side === "bull" ? "多头" : "空头"}，信心 ${c.confidence}）${c.topic}\n  证据：${c.evidence}`);
    return `### 本轮必须回应的焦点 claim\n${lines.join("\n")}`;
}
/**
 * Format the list of still-unresolved claims (the crux of disagreement).
 */
function buildUnresolvedText(ids, registryById) {
    const claims = ids.map((id) => registryById.get(id)).filter((c) => !!c);
    if (claims.length === 0)
        return "（暂无未解决 claim）";
    const lines = claims.map((c) => `- [${c.id}]（${c.side === "bull" ? "多头" : "空头"}）${c.topic}`);
    return `### 仍未解决的 claim\n${lines.join("\n")}`;
}
/**
 * Apply a parsed DEBATE_STATE payload to the global registry: register new
 * claims with stable counter-based IDs, update statuses, and compute the
 * focus IDs for the next turn.
 */
function processDebateState(state, side, round, reg) {
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
        if (c)
            c.status = "resolved";
        reg.resolvedIds.add(id);
        reg.unresolvedIds.delete(id);
    }
    // 3. Mark unresolved claims (only if not already resolved)
    for (const id of state.unresolved_claim_ids) {
        if (reg.resolvedIds.has(id))
            continue;
        const c = reg.byId.get(id);
        if (c && c.status !== "resolved")
            c.status = "unresolved";
        reg.unresolvedIds.add(id);
    }
    // 4. Register new claims with global counter IDs (override LLM IDs)
    const newClaims = [];
    for (const nc of state.new_claims) {
        reg.counter[side]++;
        const id = `${side.toUpperCase()}-${reg.counter[side]}`;
        const claim = {
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
            .filter((c) => !!c)
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
async function runBullBearDebate(analystReports, qualitySummary, config, openaiClient, traceLogger) {
    const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");
    const reportsText = analystReports
        .map((r) => `## ${r.role} 分析师\n${r.content}`)
        .join("\n\n");
    const rounds = [];
    let totalTokens = 0;
    let totalCostUsd = 0;
    let bullSummary = "";
    let bearSummary = "";
    // DEBATE_STATE tracking
    const registry = {
        claims: [],
        byId: new Map(),
        resolvedIds: new Set(),
        unresolvedIds: new Set(),
        counter: { bull: 0, bear: 0 },
    };
    let focusIds = [];
    let lastRoundSummary = "";
    let lastRoundGoal = "";
    let lastBearClaims = [];
    for (let round = 1; round <= config.debate_rounds; round++) {
        const resolvedThisRound = new Set();
        let bullRespondedIds = [];
        let bearRespondedIds = [];
        // ── Bull's turn ──────────────────────────────────────────────
        const bullOpponentText = lastBearClaims.length > 0
            ? `## 对方（空头）论点\n\n${lastBearClaims.map((c) => `- [${c.id}] ${c.topic}：${c.evidence}`).join("\n")}`
            : "";
        const bullFocusText = buildFocusText(focusIds, registry.byId);
        const bullUnresolvedText = buildUnresolvedText([...registry.unresolvedIds], registry.byId);
        const bullMessage = (0, prompt_loader_1.loadAndRender)("debate/bull_researcher.md", {
            ticker: "",
            date: "",
            analyst_reports: reportsText,
            opponent_claims: bullOpponentText,
            quality_summary: qualitySummary,
            focus_claims: bullFocusText,
            unresolved_claims: bullUnresolvedText,
            round_summary: lastRoundSummary,
            round_goal: lastRoundGoal,
        }, promptsBaseDir);
        const bullResult = await (0, llm_client_1.callLLM)(openaiClient, {
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
        let bullClaims;
        if (bullState) {
            const processed = processDebateState(bullState, "bull", round, registry);
            bullClaims = processed.newClaims;
            bullRespondedIds = bullState.responded_claim_ids;
            bullState.resolved_claim_ids.forEach((id) => resolvedThisRound.add(id));
            focusIds = processed.nextFocus;
            if (bullState.round_summary)
                lastRoundSummary = bullState.round_summary;
            if (bullState.round_goal)
                lastRoundGoal = bullState.round_goal;
        }
        else {
            bullClaims = parseClaims(bullResult.content, "bull");
        }
        const bullSummaryText = extractSummary(bullResult.content);
        // ── Bear's turn ──────────────────────────────────────────────
        const bearOpponentText = bullClaims.length > 0
            ? `## 对方（多头）论点\n\n${bullClaims.map((c) => `- [${c.id}] ${c.topic}：${c.evidence}`).join("\n")}`
            : "";
        const bearFocusText = buildFocusText(focusIds, registry.byId);
        const bearUnresolvedText = buildUnresolvedText([...registry.unresolvedIds], registry.byId);
        const bearMessage = (0, prompt_loader_1.loadAndRender)("debate/bear_researcher.md", {
            ticker: "",
            date: "",
            analyst_reports: reportsText,
            opponent_claims: bearOpponentText,
            quality_summary: qualitySummary,
            focus_claims: bearFocusText,
            unresolved_claims: bearUnresolvedText,
            round_summary: lastRoundSummary,
            round_goal: lastRoundGoal,
        }, promptsBaseDir);
        const bearResult = await (0, llm_client_1.callLLM)(openaiClient, {
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
        let bearClaims;
        if (bearState) {
            const processed = processDebateState(bearState, "bear", round, registry);
            bearClaims = processed.newClaims;
            bearRespondedIds = bearState.responded_claim_ids;
            bearState.resolved_claim_ids.forEach((id) => resolvedThisRound.add(id));
            focusIds = processed.nextFocus;
            if (bearState.round_summary)
                lastRoundSummary = bearState.round_summary;
            if (bearState.round_goal)
                lastRoundGoal = bearState.round_goal;
        }
        else {
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
//# sourceMappingURL=debate.js.map