import { describe, it, expect } from "vitest";
import { LLMError, ParseError, AbortError, EnvironmentError, TradingError } from "../../src/errors";

describe("Custom error classes", () => {
  it("LLMError should have phase and role", () => {
    const err = new LLMError("rate limited", "analyst", "market");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TradingError);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.name).toBe("LLMError");
    expect(err.message).toBe("rate limited");
    expect(err.phase).toBe("analyst");
    expect(err.role).toBe("market");
  });

  it("LLMError should carry cause", () => {
    const cause = new Error("429 Too Many Requests");
    const err = new LLMError("API error", "debate", "bull", cause);
    expect(err.cause).toBe(cause);
  });

  it("ParseError should have phase", () => {
    const err = new ParseError("verdict not found", "portfolio");
    expect(err).toBeInstanceOf(TradingError);
    expect(err).toBeInstanceOf(ParseError);
    expect(err.name).toBe("ParseError");
    expect(err.phase).toBe("portfolio");
  });

  it("AbortError should have default message", () => {
    const err = new AbortError();
    expect(err).toBeInstanceOf(TradingError);
    expect(err).toBeInstanceOf(AbortError);
    expect(err.message).toBe("Analysis aborted by user");
  });

  it("AbortError should accept custom message", () => {
    const err = new AbortError("custom abort");
    expect(err.message).toBe("custom abort");
  });

  it("EnvironmentError should carry message", () => {
    const err = new EnvironmentError("report_dir not writable");
    expect(err).toBeInstanceOf(TradingError);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect(err.name).toBe("EnvironmentError");
    expect(err.message).toBe("report_dir not writable");
  });

  it("should be distinguishable with instanceof", () => {
    const errors = [
      new LLMError("a", "b", "c"),
      new ParseError("d", "e"),
      new AbortError(),
      new EnvironmentError("f"),
    ];
    expect(errors[0]).toBeInstanceOf(LLMError);
    expect(errors[1]).toBeInstanceOf(ParseError);
    expect(errors[2]).toBeInstanceOf(AbortError);
    expect(errors[3]).toBeInstanceOf(EnvironmentError);
    // All are TradingError
    for (const e of errors) {
      expect(e).toBeInstanceOf(TradingError);
      expect(e).toBeInstanceOf(Error);
    }
    // Cross-check fails
    expect(errors[0]).not.toBeInstanceOf(ParseError);
    expect(errors[1]).not.toBeInstanceOf(AbortError);
  });
});
