// src/trace-logger.ts

import * as fs from "fs";
import * as path from "path";
import { LLMCallTrace } from "./types";

export class TraceLogger {
  private traceDir: string;
  private counter: number = 0;

  constructor(traceDir: string) {
    this.traceDir = traceDir;
    fs.mkdirSync(traceDir, { recursive: true });
  }

  /** Record a single LLM call trace to disk as JSON */
  record(trace: LLMCallTrace): void {
    const filePath = path.join(this.traceDir, `${trace.trace_id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(trace, null, 2), "utf-8");
    this.counter++;
  }

  /** Get number of traces recorded */
  get count(): number {
    return this.counter;
  }
}
