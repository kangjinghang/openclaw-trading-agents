// src/trace-logger.ts

import * as fs from "fs";
import * as path from "path";
import { LLMCallTrace, FallbackWarning } from "./types";

export class TraceLogger {
  private traceDir: string;
  private _runId: string;
  private counter: number = 0;
  private _totalTokens: number = 0;
  private _totalCostUsd: number = 0;
  private _warnings: FallbackWarning[] = [];

  constructor(traceDir: string, runId: string = "") {
    this.traceDir = traceDir;
    this._runId = runId;
    fs.mkdirSync(traceDir, { recursive: true });
  }

  /** Record a single LLM call trace to disk as JSON, enriching with run_id */
  record(trace: LLMCallTrace): void {
    const enriched = { ...trace, run_id: this._runId };
    // Lead the filename with the role so the trace dir is browsable
    // ("which file is the trader?" → scan the prefix). call_index is NOT
    // unique within a run (parallel calls read traceLogger.count before
    // record() increments it), so uniqueness comes from trace_id, never
    // from index — two traces sharing role+index still get distinct files.
    const filePath = path.join(this.traceDir, `${trace.role}-${trace.trace_id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(enriched, null, 2), "utf-8");
    this.counter++;
    this._totalTokens += trace.meta.usage.total_tokens;
    this._totalCostUsd += trace.meta.cost_usd;
  }

  /** Get number of traces recorded */
  get count(): number {
    return this.counter;
  }

  /** Get accumulated total tokens across all traces */
  get totalTokens(): number {
    return this._totalTokens;
  }

  /** Get accumulated total cost in USD across all traces */
  get totalCostUsd(): number {
    return this._totalCostUsd;
  }

  /** Get the run ID */
  get runId(): string {
    return this._runId;
  }

  /**
   * Record a silent fallback that fired (parse → default/synonym/alternative).
   * `severity` defaults to "warn"; pass "error" for dangerous defaults like
   * risk → "pass" or a numeric field falling to 0. Kept on the TraceLogger so
   * warnings share the run's lifecycle without threading a collector through
   * every pure parse function.
   */
  recordWarning(warning: Omit<FallbackWarning, "severity"> & { severity?: FallbackWarning["severity"] }): void {
    this._warnings.push({ severity: "warn", ...warning } as FallbackWarning);
  }

  /** Get all fallback warnings recorded this run */
  get warnings(): FallbackWarning[] {
    return this._warnings;
  }
}
