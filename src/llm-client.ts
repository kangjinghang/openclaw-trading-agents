// src/llm-client.ts

import OpenAI from "openai";
import { TraceLogger } from "./trace-logger";
import { LLMCallTrace, Verdict } from "./types";
import { LLMError } from "./errors";
import { LLM_MAX_RETRIES, LLM_TIMEOUT_MS, LLM_DEFAULT_MAX_TOKENS, LLM_RETRY_DELAY_MS } from "./constants";

/** Cost per 1M tokens (input, output) */
export const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-8": { input: 15, output: 75 },
};

export interface LLMCallOptions {
  model: string;
  systemPrompt: string;
  userMessage: string;
  temperature?: number;
  maxTokens?: number;
  phase: LLMCallTrace["phase"];
  role: string;
  traceLogger: TraceLogger;
}

export interface LLMCallResult {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  costUsd: number;
  traceId: string;
}

/** Generate a unique trace ID */
function generateTraceId(): string {
  return `trace-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/** Calculate cost in USD based on model and token usage */
function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const costs = MODEL_COSTS[model];
  if (!costs) {
    // Default to gpt-4o pricing if model not found
    const defaultCosts = MODEL_COSTS["gpt-4o"];
    return (
      (promptTokens / 1_000_000) * defaultCosts.input +
      (completionTokens / 1_000_000) * defaultCosts.output
    );
  }
  return (
    (promptTokens / 1_000_000) * costs.input +
    (completionTokens / 1_000_000) * costs.output
  );
}

/**
 * Make an LLM chat completion call, record trace, and return result.
 * Automatically retries up to LLM_MAX_RETRIES times if the response content is empty.
 * Each attempt has a timeout of LLM_TIMEOUT_MS to prevent indefinite hangs.
 */
export async function callLLM(
  client: OpenAI,
  options: LLMCallOptions
): Promise<LLMCallResult> {
  const {
    model,
    systemPrompt,
    userMessage,
    temperature = 0.4,
    maxTokens = LLM_DEFAULT_MAX_TOKENS,
    phase,
    role,
    traceLogger,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    const traceId = generateTraceId();
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

      let response;
      try {
        response = await client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          temperature,
          max_tokens: maxTokens,
        }, { signal: controller.signal });
      } finally {
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

      const costUsd = calculateCost(
        model,
        usage.prompt_tokens,
        usage.completion_tokens
      );

      const parsedVerdict = parseVerdict(content);

      const trace: LLMCallTrace = {
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
        },
      };

      traceLogger.record(trace);

      // If content is non-empty, return immediately
      if (content.trim().length > 0) {
        return { content, usage, costUsd, traceId };
      }

      // Empty response — retry if attempts remain
      if (attempt < LLM_MAX_RETRIES) {
        console.error(`  [LLM] ${phase}/${role} returned empty content, retrying (${attempt + 1}/${LLM_MAX_RETRIES})...`);
        // Brief pause before retry to avoid immediate re-hit
        await new Promise((r) => setTimeout(r, LLM_RETRY_DELAY_MS + Math.random() * LLM_RETRY_DELAY_MS));
      }
    } catch (error) {
      const endTime = Date.now();
      const durationMs = endTime - startTime;

      const errorTrace: LLMCallTrace = {
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
        },
      };

      traceLogger.record(errorTrace);

      lastError = error;

      // API error — retry if attempts remain
      if (attempt < LLM_MAX_RETRIES) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`  [LLM] ${phase}/${role} API error: ${errMsg}, retrying (${attempt + 1}/${LLM_MAX_RETRIES})...`);
        await new Promise((r) => setTimeout(r, LLM_RETRY_DELAY_MS + Math.random() * LLM_RETRY_DELAY_MS));
      }
    }
  }

  // All retries exhausted
  if (lastError) {
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new LLMError(msg, phase, role, lastError);
  }

  // All retries returned empty content — log warning and return empty result
  console.error(`  [LLM] WARNING: ${phase}/${role} returned empty content after ${LLM_MAX_RETRIES + 1} attempts`);
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
export function parseVerdict(
  content: string
): { direction: string; reason: string } | null {
  // ── Layer 1: VERDICT tag ──────────────────────────────────────
  const verdictRegex = /<!--\s*VERDICT:\s*(\{.*?\})\s*-->/s;
  const match = content.match(verdictRegex);
  if (match) {
    try {
      const verdict = JSON.parse(match[1]);
      if (typeof verdict.direction === "string" && typeof verdict.reason === "string") {
        return { direction: verdict.direction, reason: verdict.reason };
      }
    } catch {
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
function classifyDirection(text: string): string | null {
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

  // Score each category by counting keyword hits
  let buyScore = 0, sellScore = 0, holdScore = 0;
  for (const kw of buyKeywords) {
    if (upper.includes(kw.toUpperCase())) buyScore++;
  }
  for (const kw of sellKeywords) {
    if (upper.includes(kw.toUpperCase())) sellScore++;
  }
  for (const kw of holdKeywords) {
    if (upper.includes(kw.toUpperCase())) holdScore++;
  }

  // Return the highest-scoring category; ties broken by priority: Sell > Buy > Hold
  const maxScore = Math.max(buyScore, sellScore, holdScore);
  if (maxScore === 0) return null;
  if (sellScore === maxScore) return "Sell";
  if (buyScore === maxScore) return "Buy";
  return "Hold";
}
