/** Base class for all trading-agent errors */
export declare class TradingError extends Error {
    readonly cause?: unknown;
    constructor(message: string, cause?: unknown);
}
/** LLM API call failure (rate limit, auth, network, timeout, etc.) */
export declare class LLMError extends TradingError {
    readonly phase: string;
    readonly role: string;
    constructor(message: string, phase: string, role: string, cause?: unknown);
}
/** Verdict / claim / argument parse failure */
export declare class ParseError extends TradingError {
    readonly phase: string;
    constructor(message: string, phase: string, cause?: unknown);
}
/** User-initiated abort (Ctrl+C, SIGTERM) */
export declare class AbortError extends TradingError {
    constructor(message?: string);
}
/** Environment / pre-check failure (missing deps, unwritable dir) */
export declare class EnvironmentError extends TradingError {
    constructor(message: string, cause?: unknown);
}
//# sourceMappingURL=errors.d.ts.map