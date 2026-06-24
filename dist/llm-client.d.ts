import OpenAI from "openai";
import { TraceLogger } from "./trace-logger";
import { LLMCallTrace } from "./types";
/** Cost per 1M tokens (input, output), in USD.
 *
 * GLM prices are the official ZhiPu tiers (CNY/M, input/output) converted to
 * USD at ~¥7.2/$. GLM-4.7-Flash is free under the basic tier (1 concurrency);
 * we carry a nominal figure so a run reports a small but nonzero cost instead
 * of misleadingly showing $0 when the model actually consumed quota. Override
 * by adding an entry here when ZhiPu updates pricing.
 */
export declare const MODEL_COSTS: Record<string, {
    input: number;
    output: number;
}>;
export interface LLMCallOptions {
    model: string;
    systemPrompt: string;
    userMessage: string;
    temperature?: number;
    maxTokens?: number;
    phase: LLMCallTrace["phase"];
    role: string;
    traceLogger: TraceLogger;
    /** Optional coordinator for adaptive rate limiting across concurrent calls */
    rateLimitCoordinator?: RateLimitCoordinator;
    /** Optional thinking mode (e.g. { type: "disabled" }) for GLM models */
    thinking?: {
        type: string;
    };
    /** JSON output mode. Pass { type: "json_object" } when the model supports it.
     *  Parse functions always fall back to extractJson() for non-supporting models. */
    responseFormat?: {
        type: "json_object";
    };
}
export interface LLMCallResult {
    content: string;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    costUsd: number;
    traceId: string;
}
export declare function hasUnknownModelCost(): boolean;
/** Check if an error is a 429 rate limit error */
export declare function is429(error: unknown): boolean;
/** Extract Retry-After from error headers, returns ms or undefined */
export declare function getRetryAfterMs(error: unknown): number | undefined;
/** Compute retry delay for a given error and attempt index */
export declare function retryDelayMs(error: unknown, attempt: number): number;
/**
 * Shared coordinator for adaptive rate limiting across concurrent LLM calls.
 * When one call hits a 429, it signals the cooldown so other pending calls
 * wait before starting — preventing retry storms across parallel workers.
 */
export declare class RateLimitCoordinator {
    private cooldownUntil;
    /** Called when a 429 is detected — tells other callers to slow down. */
    signalRateLimit(delayMs: number): void;
    /** Wait if we're currently in a cooldown period. Call before each LLM request. */
    waitIfNeeded(): Promise<void>;
}
/**
 * Make an LLM chat completion call, record trace, and return result.
 * Automatically retries up to LLM_MAX_RETRIES times if the response content is empty.
 * Each attempt has a timeout of LLM_TIMEOUT_MS to prevent indefinite hangs.
 */
export declare function callLLM(client: OpenAI, options: LLMCallOptions): Promise<LLMCallResult>;
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
export declare function extractTaggedJson(content: string, tag: string): string | null;
export declare function parseVerdict(content: string): {
    direction: string;
    reason: string;
} | null;
//# sourceMappingURL=llm-client.d.ts.map