// tests/ts/test_trace_logger.ts

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TraceLogger } from "../../src/trace-logger";
import { LLMCallTrace } from "../../src/types";

describe("TraceLogger", () => {
  let traceDir: string;

  afterEach(() => {
    // Clean up temp directory after each test
    if (fs.existsSync(traceDir)) {
      fs.rmSync(traceDir, { recursive: true, force: true });
    }
  });

  it("Should write trace JSON to disk", () => {
    // Create temp directory
    traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-test-"));

    const logger = new TraceLogger(traceDir, "run-test-001");

    const trace: LLMCallTrace = {
      trace_id: "trace-test-123",
      call_index: 0,
      phase: "analyst",
      role: "value_investor",
      request: {
        model: "gpt-4o",
        system_prompt: "You are a value investor.",
        user_message: "Analyze AAPL",
        temperature: 0.4,
        max_tokens: 4000,
      },
      response: {
        raw_content: "AAPL looks undervalued. <!-- VERDICT: {\"direction\": \"Buy\", \"reason\": \"Strong fundamentals\"} -->",
        parsed_verdict: {
          direction: "Buy",
          reason: "Strong fundamentals",
        },
      },
      meta: {
        timestamp: "2024-01-01T12:00:00.000Z",
        duration_ms: 1500,
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          total_tokens: 1500,
        },
        cost_usd: 0.0075,
      },
    };

    // Record the trace
    logger.record(trace);

    // Verify file exists
    const traceFilePath = path.join(traceDir, "value_investor-trace-test-123.json");
    expect(fs.existsSync(traceFilePath)).toBe(true);

    // Verify file content
    const fileContent = fs.readFileSync(traceFilePath, "utf-8");
    const parsedTrace = JSON.parse(fileContent);

    expect(parsedTrace.trace_id).toBe("trace-test-123");
    expect(parsedTrace.run_id).toBe("run-test-001");
    expect(parsedTrace.phase).toBe("analyst");
    expect(parsedTrace.role).toBe("value_investor");
    expect(parsedTrace.request.model).toBe("gpt-4o");
    expect(parsedTrace.response.raw_content).toContain("AAPL looks undervalued");
    expect(parsedTrace.meta.cost_usd).toBe(0.0075);
  });

  it("Should auto-increment trace IDs", () => {
    // Create temp directory
    traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-test-"));

    const logger = new TraceLogger(traceDir, "run-test-002");

    const trace1: LLMCallTrace = {
      trace_id: "trace-001",
      call_index: 0,
      phase: "analyst",
      role: "value_investor",
      request: {
        model: "gpt-4o",
        system_prompt: "You are a value investor.",
        user_message: "Analyze AAPL",
        temperature: 0.4,
        max_tokens: 4000,
      },
      response: {
        raw_content: "AAPL analysis",
      },
      meta: {
        timestamp: "2024-01-01T12:00:00.000Z",
        duration_ms: 1000,
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          total_tokens: 1500,
        },
        cost_usd: 0.0075,
      },
    };

    const trace2: LLMCallTrace = {
      trace_id: "trace-002",
      call_index: 1,
      phase: "debate",
      role: "growth_investor",
      request: {
        model: "gpt-4o",
        system_prompt: "You are a growth investor.",
        user_message: "Debate AAPL",
        temperature: 0.4,
        max_tokens: 4000,
      },
      response: {
        raw_content: "Growth perspective",
      },
      meta: {
        timestamp: "2024-01-01T12:01:00.000Z",
        duration_ms: 1200,
        usage: {
          prompt_tokens: 1500,
          completion_tokens: 600,
          total_tokens: 2100,
        },
        cost_usd: 0.009,
      },
    };

    // Record both traces
    logger.record(trace1);
    logger.record(trace2);

    // Verify both files exist
    const trace1Path = path.join(traceDir, "value_investor-trace-001.json");
    const trace2Path = path.join(traceDir, "growth_investor-trace-002.json");

    expect(fs.existsSync(trace1Path)).toBe(true);
    expect(fs.existsSync(trace2Path)).toBe(true);

    // Verify counter is incremented
    expect(logger.count).toBe(2);

    // Verify file contents
    const content1 = JSON.parse(fs.readFileSync(trace1Path, "utf-8"));
    const content2 = JSON.parse(fs.readFileSync(trace2Path, "utf-8"));

    expect(content1.trace_id).toBe("trace-001");
    expect(content1.phase).toBe("analyst");
    expect(content2.trace_id).toBe("trace-002");
    expect(content2.phase).toBe("debate");
  });

  it("Should encode the role in the filename and stay unique when role+index collide", () => {
    // The filename leads with the role so the 06_traces dir is browsable
    // ("which file is the trader?"). call_index is NOT unique within a run
    // (parallel calls read traceLogger.count before record() increments it),
    // so uniqueness must come from trace_id — two traces sharing both role
    // AND call_index must still produce two distinct files, never an overwrite.
    traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-test-"));
    const logger = new TraceLogger(traceDir, "run-dup");

    const make = (trace_id: string): LLMCallTrace => ({
      trace_id,
      call_index: 5,           // identical index for both — must NOT cause a collision
      phase: "debate",
      role: "bull",            // identical role for both
      request: {
        model: "gpt-4o",
        system_prompt: "Bull debater.",
        user_message: "Argue bullish.",
        temperature: 0.4,
        max_tokens: 4000,
      },
      response: { raw_content: "Bull case" },
      meta: {
        timestamp: "2024-01-01T12:00:00.000Z",
        duration_ms: 1000,
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        cost_usd: 0.0075,
      },
    });

    logger.record(make("bull-aaa"));
    logger.record(make("bull-bbb"));

    expect(fs.existsSync(path.join(traceDir, "bull-bull-aaa.json"))).toBe(true);
    expect(fs.existsSync(path.join(traceDir, "bull-bull-bbb.json"))).toBe(true);

    // The first trace was NOT overwritten by the second.
    const first = JSON.parse(fs.readFileSync(path.join(traceDir, "bull-bull-aaa.json"), "utf-8"));
    expect(first.trace_id).toBe("bull-aaa");
  });
});
