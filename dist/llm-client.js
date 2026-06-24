"use strict";
// src/llm-client.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimitCoordinator = exports.MODEL_COSTS = void 0;
exports.hasUnknownModelCost = hasUnknownModelCost;
exports.is429 = is429;
exports.getRetryAfterMs = getRetryAfterMs;
exports.retryDelayMs = retryDelayMs;
exports.callLLM = callLLM;
exports.extractTaggedJson = extractTaggedJson;
exports.parseVerdict = parseVerdict;
const openai_1 = require("openai");
const errors_1 = require("./errors");
const constants_1 = require("./constants");
/** Cost per 1M tokens (input, output), in USD.
 *
 * GLM prices are the official ZhiPu tiers (CNY/M, input/output) converted to
 * USD at ~¥7.2/$. GLM-4.7-Flash is free under the basic tier (1 concurrency);
 * we carry a nominal figure so a run reports a small but nonzero cost instead
 * of misleadingly showing $0 when the model actually consumed quota. Override
 * by adding an entry here when ZhiPu updates pricing.
 */
exports.MODEL_COSTS = {
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "claude-sonnet-4-6": { input: 3, output: 15 },
    "claude-opus-4-8": { input: 15, output: 75 },
    // ZhiPu GLM — official promo tier (¥2 / ¥8 per M tokens, [0,32K) input)
    "glm-4.7": { input: 2 / 7.2, output: 8 / 7.2 },
    // flash is free at the basic tier; nominal fallback (~1/5 of paid flash rate)
    "glm-4.7-flash": { input: 0.06, output: 0.22 },
};
/** Generate a unique trace ID */
function generateTraceId() {
    return `trace-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
/** Models whose missing price entry has already been warned about this
 *  process — avoids spamming the log once per LLM call. */
const _warnedMissingCost = new Set();
/** True if any LLM call used a model not in MODEL_COSTS (cost reported as $0). */
let _hasUnknownModelCost = false;
function hasUnknownModelCost() { return _hasUnknownModelCost; }
/** Calculate cost in USD based on model and token usage */
function calculateCost(model, promptTokens, completionTokens) {
    const costs = exports.MODEL_COSTS[model];
    if (!costs) {
        // Unknown model: report $0 and warn ONCE per model (per-process) so a
        // reviewer sees the cost column is not authoritative. Previously this
        // silently fell back to gpt-4o pricing, overstating cost ~50x for the
        // default GLM models (which were absent from the table) and producing
        // a misleading total_cost_usd in run_summary / dashboard / CLI output.
        _hasUnknownModelCost = true;
        if (!_warnedMissingCost.has(model)) {
            if (_warnedMissingCost.size > 100)
                _warnedMissingCost.clear(); // 防内存泄露
            _warnedMissingCost.add(model);
            console.error(`  [LLM] cost unknown for model "${model}" — reporting $0 (add an entry to MODEL_COSTS for accurate accounting)`);
        }
        return 0;
    }
    return ((promptTokens / 1000000) * costs.input +
        (completionTokens / 1000000) * costs.output);
}
/** Check if an error is a 429 rate limit error */
function is429(error) {
    if (error instanceof openai_1.RateLimitError)
        return true;
    if (error instanceof openai_1.APIError && error.status === 429)
        return true;
    // Fallback: check message for 429 (non-standard API providers)
    const msg = error instanceof Error ? error.message : String(error);
    return msg.startsWith("429");
}
/** Extract Retry-After from error headers, returns ms or undefined */
function getRetryAfterMs(error) {
    if (!(error instanceof openai_1.APIError))
        return undefined;
    const val = error.headers?.["retry-after"];
    if (!val)
        return undefined;
    const seconds = parseInt(val, 10);
    return Number.isNaN(seconds) ? undefined : seconds * 1000;
}
/** Compute retry delay for a given error and attempt index */
function retryDelayMs(error, attempt) {
    if (is429(error)) {
        // 429: exponential backoff 5s → 15s → 45s, prefer Retry-After header
        const retryAfter = getRetryAfterMs(error);
        const delay = retryAfter ?? (constants_1.RATE_LIMIT_BASE_DELAY_MS * Math.pow(3, attempt));
        return Math.min(delay, constants_1.RATE_LIMIT_MAX_DELAY_MS);
    }
    // Other errors: short fixed delay with jitter
    return constants_1.LLM_RETRY_DELAY_MS + Math.random() * constants_1.LLM_RETRY_DELAY_MS;
}
/**
 * Shared coordinator for adaptive rate limiting across concurrent LLM calls.
 * When one call hits a 429, it signals the cooldown so other pending calls
 * wait before starting — preventing retry storms across parallel workers.
 */
class RateLimitCoordinator {
    constructor() {
        this.cooldownUntil = 0;
    }
    /** Called when a 429 is detected — tells other callers to slow down. */
    signalRateLimit(delayMs) {
        const newCooldown = Date.now() + delayMs;
        // Only extend, never shorten — the longest backoff wins
        if (newCooldown > this.cooldownUntil) {
            this.cooldownUntil = newCooldown;
        }
    }
    /** Wait if we're currently in a cooldown period. Call before each LLM request. */
    async waitIfNeeded() {
        const now = Date.now();
        if (this.cooldownUntil > now) {
            const waitMs = this.cooldownUntil - now;
            console.error(`  [rate-limit] cooldown: waiting ${(waitMs / 1000).toFixed(1)}s before next call`);
            await new Promise(r => setTimeout(r, waitMs));
        }
    }
}
exports.RateLimitCoordinator = RateLimitCoordinator;
/**
 * Make an LLM chat completion call, record trace, and return result.
 * Automatically retries up to LLM_MAX_RETRIES times if the response content is empty.
 * Each attempt has a timeout of LLM_TIMEOUT_MS to prevent indefinite hangs.
 */
async function callLLM(client, options) {
    const { model, systemPrompt, userMessage, temperature = 0.4, maxTokens = constants_1.LLM_DEFAULT_MAX_TOKENS, phase, role, traceLogger, thinking, responseFormat, } = options;
    let lastError;
    // Total deadline across all retry attempts — caps worst-case blocking time
    // even if every attempt times out. Without this, 3 attempts × LLM_TIMEOUT_MS
    // plus backoff could stall a worker for ~15 min (observed on 300681). When the
    // deadline elapses we stop retrying and surface whatever we have.
    const deadlineStart = Date.now();
    for (let attempt = 0; attempt <= constants_1.LLM_MAX_RETRIES; attempt++) {
        // Give up if the overall deadline has already elapsed (skip even starting
        // another attempt that would just time out). The trace for the attempt that
        // crossed the line is flagged with deadline_hit so it's diagnosable.
        const deadlineHit = Date.now() - deadlineStart >= constants_1.LLM_TOTAL_DEADLINE_MS;
        if (deadlineHit && attempt > 0) {
            break;
        }
        const traceId = generateTraceId();
        const startTime = Date.now();
        const timestamp = new Date().toISOString();
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), constants_1.LLM_TIMEOUT_MS);
            let response;
            try {
                const body = {
                    model,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userMessage },
                    ],
                    temperature,
                    max_tokens: maxTokens,
                    ...(thinking ? { thinking } : {}),
                    ...(responseFormat ? { response_format: responseFormat } : {}),
                };
                response = await client.chat.completions.create(body, { signal: controller.signal });
            }
            finally {
                clearTimeout(timeout);
            }
            const endTime = Date.now();
            const durationMs = endTime - startTime;
            const content = response.choices[0]?.message?.content || "";
            const usage = {
                prompt_tokens: response.usage?.prompt_tokens || 0,
                completion_tokens: response.usage?.completion_tokens || 0,
                total_tokens: response.usage?.total_tokens || 0,
            };
            const costUsd = calculateCost(model, usage.prompt_tokens, usage.completion_tokens);
            const parsedVerdict = parseVerdict(content);
            const trace = {
                trace_id: traceId,
                call_index: traceLogger.count,
                phase,
                role,
                request: {
                    model,
                    system_prompt: systemPrompt,
                    user_message: userMessage,
                    temperature,
                    max_tokens: maxTokens,
                },
                response: {
                    raw_content: content,
                    parsed_verdict: parsedVerdict || undefined,
                },
                meta: {
                    timestamp,
                    duration_ms: durationMs,
                    usage,
                    cost_usd: costUsd,
                    ...(deadlineHit ? { deadline_hit: true } : {}),
                },
            };
            traceLogger.record(trace);
            // If content is non-empty, return immediately
            if (content.trim().length > 0) {
                return { content, usage, costUsd, traceId };
            }
            // Empty response — retry if attempts remain (and deadline hasn't elapsed)
            if (attempt < constants_1.LLM_MAX_RETRIES && Date.now() - deadlineStart < constants_1.LLM_TOTAL_DEADLINE_MS) {
                console.error(`  [LLM] ${phase}/${role} returned empty content, retrying (${attempt + 1}/${constants_1.LLM_MAX_RETRIES})...`);
                // Brief pause before retry to avoid immediate re-hit
                await new Promise((r) => setTimeout(r, constants_1.LLM_RETRY_DELAY_MS + Math.random() * constants_1.LLM_RETRY_DELAY_MS));
            }
        }
        catch (error) {
            const endTime = Date.now();
            const durationMs = endTime - startTime;
            const errorTrace = {
                trace_id: traceId,
                call_index: traceLogger.count,
                phase,
                role,
                request: {
                    model,
                    system_prompt: systemPrompt,
                    user_message: userMessage,
                    temperature,
                    max_tokens: maxTokens,
                },
                response: {
                    raw_content: "",
                    parsed_verdict: undefined,
                },
                meta: {
                    timestamp,
                    duration_ms: durationMs,
                    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                    cost_usd: 0,
                    ...(deadlineHit ? { deadline_hit: true } : {}),
                },
            };
            traceLogger.record(errorTrace);
            lastError = error;
            // API error — retry if attempts remain (and deadline hasn't elapsed).
            // Skipping the retry pause when the deadline is up keeps us from padding
            // an already-too-long stall with backoff delays that can no longer help.
            if (attempt < constants_1.LLM_MAX_RETRIES && Date.now() - deadlineStart < constants_1.LLM_TOTAL_DEADLINE_MS) {
                const errMsg = error instanceof Error ? error.message : String(error);
                const delay = retryDelayMs(error, attempt);
                console.error(`  [LLM] ${phase}/${role} API error: ${errMsg}, retrying in ${(delay / 1000).toFixed(1)}s (${attempt + 1}/${constants_1.LLM_MAX_RETRIES})...`);
                // Signal other concurrent callers to slow down on 429
                if (is429(error) && options.rateLimitCoordinator) {
                    options.rateLimitCoordinator.signalRateLimit(delay);
                }
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }
    // All retries exhausted (or deadline elapsed)
    if (lastError) {
        const msg = lastError instanceof Error ? lastError.message : String(lastError);
        const elapsed = Date.now() - deadlineStart;
        const deadlineNote = elapsed >= constants_1.LLM_TOTAL_DEADLINE_MS
            ? ` (stopped after ${constants_1.LLM_TOTAL_DEADLINE_MS / 1000}s total deadline)`
            : "";
        throw new errors_1.LLMError(msg + deadlineNote, phase, role, lastError);
    }
    // All retries returned empty content — log warning and return empty result
    console.error(`  [LLM] WARNING: ${phase}/${role} returned empty content after ${constants_1.LLM_MAX_RETRIES + 1} attempts`);
    return {
        content: "",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        costUsd: 0,
        traceId: generateTraceId(),
    };
}
/**
 * Extract verdict from LLM output.
 *
 * Extraction strategy (in priority order):
 * 1. VERDICT tag: <!-- VERDICT: {"direction": "...", "reason": "..."} -->
 * 2. Explicit patterns: "最终裁决：买入", "方向：看空", "核心定性：持有"
 * 3. Keyword scan: look for direction keywords in the first 20 lines
 *
 * Returns null only if no direction signal can be found at all.
 */
/** Extract JSON from <!-- TAG: {...} --> using brace-depth matching.
 *  More robust than {.*?} which fails on nested JSON or unbalanced braces. */
function extractTaggedJson(content, tag) {
    const tagIdx = content.indexOf(`${tag}:`);
    if (tagIdx === -1)
        return null;
    const jsonStart = content.indexOf("{", tagIdx);
    if (jsonStart === -1)
        return null;
    let depth = 0;
    for (let i = jsonStart; i < content.length; i++) {
        if (content[i] === "{")
            depth++;
        else if (content[i] === "}") {
            depth--;
            if (depth === 0)
                return content.slice(jsonStart, i + 1);
        }
    }
    return null;
}
function parseVerdict(content) {
    // ── Layer 1: VERDICT tag ──────────────────────────────────────
    const jsonStr = extractTaggedJson(content, "VERDICT");
    if (jsonStr) {
        try {
            const verdict = JSON.parse(jsonStr);
            if (typeof verdict.direction === "string" && typeof verdict.reason === "string") {
                return { direction: verdict.direction, reason: verdict.reason };
            }
        }
        catch {
            // Fall through to next layer
        }
    }
    // ── Layer 2: Explicit label patterns ──────────────────────────
    const explicitPatterns = [
        /(?:最终裁决|最终建议|核心定性|方向|结论|综合判断)[:：]\s*([^\n*]{1,30})/,
    ];
    for (const pattern of explicitPatterns) {
        const m = content.match(pattern);
        if (m) {
            const classified = classifyDirection(m[1].trim());
            if (classified) {
                return { direction: classified, reason: `fallback(explicit): ${m[1].trim()}` };
            }
        }
    }
    // ── Layer 3: Keyword scan in first 20 lines ───────────────────
    const head = content.split("\n").slice(0, 20).join("\n");
    const keywordResult = classifyDirection(head);
    if (keywordResult) {
        return { direction: keywordResult, reason: "fallback(keyword)" };
    }
    return null;
}
/**
 * Classify a text snippet into a canonical direction via keyword matching.
 * Returns "Buy", "Sell", "Hold", or null if no signal found.
 */
function classifyDirection(text) {
    const upper = text.toUpperCase();
    const buyKeywords = [
        "BUY", "买入", "增持", "做多", "看多", "偏多", "建仓",
    ];
    const sellKeywords = [
        "SELL", "卖出", "减持", "做空", "看空", "偏空", "清仓", "回避",
    ];
    const holdKeywords = [
        "HOLD", "持有", "观望", "中性", "谨慎",
    ];
    const negations = ["不", "非", "无", "没", "NOT", "NO", "NEITHER", "WITHOUT"];
    // Score each category, skipping negated keywords ("不买入" → skip 买入)
    let buyScore = 0, sellScore = 0, holdScore = 0;
    for (const kw of buyKeywords) {
        const upperKw = kw.toUpperCase();
        let idx = upper.indexOf(upperKw);
        while (idx !== -1) {
            const prefix = upper.slice(Math.max(0, idx - 3), idx);
            const negated = negations.some(n => prefix.includes(n.toUpperCase()));
            if (!negated)
                buyScore++;
            idx = upper.indexOf(upperKw, idx + upperKw.length);
        }
    }
    for (const kw of sellKeywords) {
        const upperKw = kw.toUpperCase();
        let idx = upper.indexOf(upperKw);
        while (idx !== -1) {
            const prefix = upper.slice(Math.max(0, idx - 3), idx);
            const negated = negations.some(n => prefix.includes(n.toUpperCase()));
            if (!negated)
                sellScore++;
            idx = upper.indexOf(upperKw, idx + upperKw.length);
        }
    }
    for (const kw of holdKeywords) {
        const upperKw = kw.toUpperCase();
        let idx = upper.indexOf(upperKw);
        while (idx !== -1) {
            const prefix = upper.slice(Math.max(0, idx - 3), idx);
            const negated = negations.some(n => prefix.includes(n.toUpperCase()));
            if (!negated)
                holdScore++;
            idx = upper.indexOf(upperKw, idx + upperKw.length);
        }
    }
    // Return the highest-scoring category; ties broken by priority: Sell > Buy > Hold
    const maxScore = Math.max(buyScore, sellScore, holdScore);
    if (maxScore === 0)
        return null;
    if (sellScore === maxScore)
        return "Sell";
    if (buyScore === maxScore)
        return "Buy";
    return "Hold";
}
//# sourceMappingURL=llm-client.js.map