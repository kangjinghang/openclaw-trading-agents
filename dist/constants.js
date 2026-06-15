"use strict";
// src/constants.ts — Centralized configuration constants
Object.defineProperty(exports, "__esModule", { value: true });
exports.RATE_LIMIT_MAX_DELAY_MS = exports.RATE_LIMIT_BASE_DELAY_MS = exports.DEFAULT_CACHE_DIR = exports.CACHE_TTL_MS = exports.DEFAULT_LLM_CONCURRENCY = exports.DEFAULT_CONCURRENCY = exports.LLM_CALL_STAGGER_MS = exports.DATA_FETCH_STAGGER_MS = exports.PYTHON_SCRIPT_TIMEOUT_MS = exports.LLM_RETRY_DELAY_MS = exports.LLM_DEFAULT_MAX_TOKENS = exports.LLM_TOTAL_DEADLINE_MS = exports.LLM_TIMEOUT_MS = exports.LLM_MAX_RETRIES = void 0;
/** Maximum retries for empty LLM responses */
exports.LLM_MAX_RETRIES = 2;
/** Timeout per single LLM call attempt (2 minutes).
 *
 * Was 5 minutes — but a single hung call blocking a worker for 5 min, then
 * retried up to 2 more times, made the worst case ~15 min (observed: 300681
 * full run took 36 min after one fundamentals call hung the full 5 min).
 * 2 min is generous for any model that is actually responding; a call that
 * hasn't returned by then is effectively hung and should abort so the retry
 * loop or the total deadline can take over. */
exports.LLM_TIMEOUT_MS = 2 * 60 * 1000;
/** Total deadline across all retry attempts for one logical callLLM (8 minutes).
 *
 * Caps the worst-case blocking time even when every attempt times out and
 * retries: with LLM_TIMEOUT_MS=2min and LLM_MAX_RETRIES=2, three attempts could
 * otherwise run ~6-7 min plus backoff. This hard ceiling makes callLLM give up
 * deterministically rather than compound slow retries into a long stall. */
exports.LLM_TOTAL_DEADLINE_MS = 8 * 60 * 1000;
/** Default max tokens for LLM responses */
exports.LLM_DEFAULT_MAX_TOKENS = 16000;
/** Base delay before LLM retry (ms), actual = base + random(0, base) */
exports.LLM_RETRY_DELAY_MS = 1000;
/** Timeout for Python data scripts (30 seconds) */
exports.PYTHON_SCRIPT_TIMEOUT_MS = 30000;
/** Stagger jitter between data script starts (0~1500ms, for Eastmoney rate limit) */
exports.DATA_FETCH_STAGGER_MS = 1500;
/** Stagger jitter between LLM calls (0~2000ms, for API rate limit avoidance) */
exports.LLM_CALL_STAGGER_MS = 2000;
/** Default concurrency for parallel operations (data fetch + LLM calls) */
exports.DEFAULT_CONCURRENCY = 2;
/**
 * Default LLM concurrency used when config omits `llm_concurrency`. A single
 * source of truth shared by the plugin entry (src/index.ts), the standalone
 * CLI (src/cli.ts), and the `config.llm_concurrency || …` fallbacks in the
 * orchestrator / risk phase. Tuned conservative for rate-limited GLM tiers;
 * raise it for providers with higher headroom.
 */
exports.DEFAULT_LLM_CONCURRENCY = 2;
/** TTL for data script cache entries (4 hours — covers repeated runs same day) */
exports.CACHE_TTL_MS = 4 * 60 * 60 * 1000;
/** Default cache directory for data script results */
exports.DEFAULT_CACHE_DIR = "~/.openclaw/cache";
/** Base delay for 429 rate limit retries (ms), actual = base * 3^attempt */
exports.RATE_LIMIT_BASE_DELAY_MS = 5000;
/** Maximum delay for 429 retries (ms) */
exports.RATE_LIMIT_MAX_DELAY_MS = 60000;
//# sourceMappingURL=constants.js.map