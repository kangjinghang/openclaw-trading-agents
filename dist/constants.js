"use strict";
// src/constants.ts — Centralized configuration constants
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CACHE_DIR = exports.CACHE_TTL_MS = exports.DEFAULT_CONCURRENCY = exports.LLM_CALL_STAGGER_MS = exports.DATA_FETCH_STAGGER_MS = exports.PYTHON_SCRIPT_TIMEOUT_MS = exports.LLM_RETRY_DELAY_MS = exports.LLM_DEFAULT_MAX_TOKENS = exports.LLM_TIMEOUT_MS = exports.LLM_MAX_RETRIES = void 0;
/** Maximum retries for empty LLM responses */
exports.LLM_MAX_RETRIES = 2;
/** Timeout per LLM call (5 minutes) */
exports.LLM_TIMEOUT_MS = 5 * 60 * 1000;
/** Default max tokens for LLM responses */
exports.LLM_DEFAULT_MAX_TOKENS = 16000;
/** Base delay before LLM retry (ms), actual = base + random(0, base) */
exports.LLM_RETRY_DELAY_MS = 1000;
/** Timeout for Python data scripts (30 seconds) */
exports.PYTHON_SCRIPT_TIMEOUT_MS = 30000;
/** Stagger jitter between data script starts (0~1500ms, for Eastmoney rate limit) */
exports.DATA_FETCH_STAGGER_MS = 1500;
/** Stagger jitter between LLM calls (0~800ms, for API rate limit) */
exports.LLM_CALL_STAGGER_MS = 800;
/** Default concurrency for parallel operations */
exports.DEFAULT_CONCURRENCY = 3;
/** TTL for data script cache entries (4 hours — covers repeated runs same day) */
exports.CACHE_TTL_MS = 4 * 60 * 60 * 1000;
/** Default cache directory for data script results */
exports.DEFAULT_CACHE_DIR = "~/.openclaw/cache";
//# sourceMappingURL=constants.js.map