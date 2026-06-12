"use strict";
// src/errors.ts — Custom error classes for different failure modes
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnvironmentError = exports.AbortError = exports.ParseError = exports.LLMError = exports.TradingError = void 0;
/** Base class for all trading-agent errors */
class TradingError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = this.constructor.name;
        this.cause = cause;
    }
}
exports.TradingError = TradingError;
/** LLM API call failure (rate limit, auth, network, timeout, etc.) */
class LLMError extends TradingError {
    constructor(message, phase, role, cause) {
        super(message, cause);
        this.phase = phase;
        this.role = role;
    }
}
exports.LLMError = LLMError;
/** Verdict / claim / argument parse failure */
class ParseError extends TradingError {
    constructor(message, phase, cause) {
        super(message, cause);
        this.phase = phase;
    }
}
exports.ParseError = ParseError;
/** User-initiated abort (Ctrl+C, SIGTERM) */
class AbortError extends TradingError {
    constructor(message = "Analysis aborted by user") {
        super(message);
    }
}
exports.AbortError = AbortError;
/** Environment / pre-check failure (missing deps, unwritable dir) */
class EnvironmentError extends TradingError {
    constructor(message, cause) {
        super(message, cause);
    }
}
exports.EnvironmentError = EnvironmentError;
//# sourceMappingURL=errors.js.map