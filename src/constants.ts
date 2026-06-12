// src/constants.ts — Centralized configuration constants

/** Maximum retries for empty LLM responses */
export const LLM_MAX_RETRIES = 2;

/** Timeout per LLM call (5 minutes) */
export const LLM_TIMEOUT_MS = 5 * 60 * 1000;

/** Default max tokens for LLM responses */
export const LLM_DEFAULT_MAX_TOKENS = 16000;

/** Base delay before LLM retry (ms), actual = base + random(0, base) */
export const LLM_RETRY_DELAY_MS = 1000;

/** Timeout for Python data scripts (30 seconds) */
export const PYTHON_SCRIPT_TIMEOUT_MS = 30_000;

/** Stagger jitter between data script starts (0~1500ms, for Eastmoney rate limit) */
export const DATA_FETCH_STAGGER_MS = 1500;

/** Stagger jitter between LLM calls (0~2000ms, for API rate limit avoidance) */
export const LLM_CALL_STAGGER_MS = 2000;

/** Default concurrency for parallel operations */
export const DEFAULT_CONCURRENCY = 2;

/** TTL for data script cache entries (4 hours — covers repeated runs same day) */
export const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

/** Default cache directory for data script results */
export const DEFAULT_CACHE_DIR = "~/.openclaw/cache";

/** Base delay for 429 rate limit retries (ms), actual = base * 3^attempt */
export const RATE_LIMIT_BASE_DELAY_MS = 5_000;

/** Maximum delay for 429 retries (ms) */
export const RATE_LIMIT_MAX_DELAY_MS = 60_000;
