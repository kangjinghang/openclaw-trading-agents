// src/errors.ts — Custom error classes for different failure modes

/** Base class for all trading-agent errors */
export class TradingError extends Error {
  public readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.cause = cause;
  }
}

/** LLM API call failure (rate limit, auth, network, timeout, etc.) */
export class LLMError extends TradingError {
  public readonly phase: string;
  public readonly role: string;
  constructor(message: string, phase: string, role: string, cause?: unknown) {
    super(message, cause);
    this.phase = phase;
    this.role = role;
  }
}

/** Verdict / claim / argument parse failure */
export class ParseError extends TradingError {
  public readonly phase: string;
  constructor(message: string, phase: string, cause?: unknown) {
    super(message, cause);
    this.phase = phase;
  }
}

/** User-initiated abort (Ctrl+C, SIGTERM) */
export class AbortError extends TradingError {
  constructor(message = "Analysis aborted by user") {
    super(message);
  }
}

/** Environment / pre-check failure (missing deps, unwritable dir) */
export class EnvironmentError extends TradingError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}
