// src/trace-logger.ts

import * as fs from "fs";
import * as path from "path";
import { LLMCallTrace } from "./types";

export class TraceLogger {
  private traceDir: string;
  private _runId: string;
  private counter: number = 0;
  private _totalTokens: number = 0;
  private _totalCostUsd: number = 0;

  constructor(traceDir: string, runId: string = "") {
    this.traceDir = traceDir;
    this._runId = runId;
    fs.mkdirSync(traceDir, { recursive: true });
  }

  /** Record a single LLM call trace to disk as JSON, enriching with run_id */
  record(trace: LLMCallTrace): void {
    const enriched = { ...trace, run_id: this._runId };
    const filePath = path.join(this.traceDir, `${trace.trace_id}.json`);
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
}
