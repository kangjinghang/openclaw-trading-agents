import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseArgs } from "../../src/cli";

describe("CLI parseArgs", () => {
  const originalApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterEach(() => {
    if (originalApiKey) {
      process.env.OPENAI_API_KEY = originalApiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("should parse quick mode with ticker", () => {
    const result = parseArgs(["quick", "600519"]);
    expect(result.mode).toBe("quick");
    expect(result.ticker).toBe("600519");
    expect(result.format).toBe("json");
    expect(result.config.models.analyst).toBe("gpt-4o");
    expect(result.config.debate_rounds).toBe(2);
  });

  it("should parse full mode with date", () => {
    const result = parseArgs(["full", "000001", "2026-01-15"]);
    expect(result.mode).toBe("full");
    expect(result.ticker).toBe("000001");
    expect(result.date).toBe("2026-01-15");
  });

  it("should parse all options", () => {
    const result = parseArgs([
      "full", "600519", "2026-06-07",
      "--debate-rounds", "3",
      "--risk-debate-rounds", "2",
      "--model", "GLM-5.1",
      "--report-dir", "/tmp/reports",
      "--format", "html",
    ]);
    expect(result.config.debate_rounds).toBe(3);
    expect(result.config.risk_debate_rounds).toBe(2);
    expect(result.config.models.analyst).toBe("GLM-5.1");
    expect(result.config.report_dir).toBe("/tmp/reports");
    expect(result.format).toBe("html");
  });

  it("should default date to today", () => {
    const result = parseArgs(["quick", "600519"]);
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("should throw on invalid mode", () => {
    expect(() => parseArgs(["invalid", "600519"]))
      .toThrow('mode must be "quick" or "full"');
  });

  it("should throw on missing ticker", () => {
    expect(() => parseArgs(["quick"]))
      .toThrow("ticker must be a 6-digit stock code");
  });

  it("should throw on invalid ticker format", () => {
    expect(() => parseArgs(["quick", "ABCDE"]))
      .toThrow("ticker must be a 6-digit stock code");
  });

  it("should throw on missing API key", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => parseArgs(["quick", "600519"]))
      .toThrow("OPENAI_API_KEY environment variable is required");
  });

  it("should throw USAGE for --help", () => {
    expect(() => parseArgs(["--help"]))
      .toThrow("USAGE");
  });

  it("should throw USAGE for empty args", () => {
    expect(() => parseArgs([]))
      .toThrow("USAGE");
  });
});
