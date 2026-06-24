/** Maximum retries for empty LLM responses */
export declare const LLM_MAX_RETRIES = 2;
/** Timeout per single LLM call attempt (5 minutes).
 *
 * 2 min was too tight for reasoning models (GLM-5-turbo) whose first inference
 * can take 60-150s due to reasoning_content generation. 5 min gives breathing
 * room while the total deadline (8 min) still caps worst-case blocking. */
export declare const LLM_TIMEOUT_MS: number;
/** Total deadline across all retry attempts for one logical callLLM (8 minutes).
 *
 * Caps the worst-case blocking time even when every attempt times out and
 * retries: with LLM_TIMEOUT_MS=2min and LLM_MAX_RETRIES=2, three attempts could
 * otherwise run ~6-7 min plus backoff. This hard ceiling makes callLLM give up
 * deterministically rather than compound slow retries into a long stall. */
export declare const LLM_TOTAL_DEADLINE_MS: number;
/** Default max tokens for LLM responses */
export declare const LLM_DEFAULT_MAX_TOKENS = 16000;
/** Base delay before LLM retry (ms), actual = base + random(0, base) */
export declare const LLM_RETRY_DELAY_MS = 1000;
/** Timeout for Python data scripts (30 seconds) */
export declare const PYTHON_SCRIPT_TIMEOUT_MS = 30000;
/** Stagger jitter between data script starts (0~1500ms, for Eastmoney rate limit) */
export declare const DATA_FETCH_STAGGER_MS = 1500;
/** Stagger jitter between LLM calls (0~2000ms, for API rate limit avoidance) */
export declare const LLM_CALL_STAGGER_MS = 2000;
/** Default concurrency for parallel operations (data fetch + LLM calls) */
export declare const DEFAULT_CONCURRENCY = 2;
/**
 * Default LLM concurrency used when config omits `llm_concurrency`. A single
 * source of truth shared by the plugin entry (src/index.ts), the standalone
 * CLI (src/cli.ts), and the `config.llm_concurrency || …` fallbacks in the
 * orchestrator / risk phase. Tuned conservative for rate-limited GLM tiers;
 * raise it for providers with higher headroom.
 */
export declare const DEFAULT_LLM_CONCURRENCY = 2;
/** TTL for data script cache entries (4 hours — covers repeated runs same day) */
export declare const CACHE_TTL_MS: number;
/** Default cache directory for data script results */
export declare const DEFAULT_CACHE_DIR = "~/.openclaw/cache";
/** Base delay for 429 rate limit retries (ms), actual = base * 3^attempt */
export declare const RATE_LIMIT_BASE_DELAY_MS = 5000;
/** Maximum delay for 429 retries (ms) */
export declare const RATE_LIMIT_MAX_DELAY_MS = 60000;
//# sourceMappingURL=constants.d.ts.map