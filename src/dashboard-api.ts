// src/dashboard-api.ts — API handlers for the dashboard server

import * as fs from "fs";
import * as path from "path";

/** Summary of a report for the list view */
export interface ReportSummary {
  id: string;
  run_id?: string;
  ticker: string;
  company_name: string;
  date: string;
  mode: "full" | "quick";
  created_at: string;
  duration_ms: number;
  total_tokens: number;
  total_cost_usd: number;
  direction: string;
  confidence: number;
  analyst_verdicts: Record<string, { direction: string; reason: string }>;
  trace_count: number;
  risk_assessment?: string;
  warnings?: Array<{ phase: string; fn: string; detail: string; severity: "warn" | "error" }>;
  cross_stage_issues?: Array<{ severity: "warn" | "error"; check: string; message: string }>;
}

/** Scan report directory and return all report summaries */
export function listReports(reportDir: string): ReportSummary[] {
  if (!fs.existsSync(reportDir)) return [];

  const reports: ReportSummary[] = [];

  const tickerDirs = safeReaddir(reportDir);
  for (const ticker of tickerDirs) {
    const tickerPath = path.join(reportDir, ticker);
    if (!fs.statSync(tickerPath).isDirectory()) continue;

    const files = safeReaddir(tickerPath);
    for (const file of files) {
      if (!file.endsWith("_quick.json") && !file.endsWith("_full.json")) continue;

      const filePath = path.join(tickerPath, file);
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        reports.push(toSummary(raw));
      } catch {
        // skip malformed reports
      }
    }
  }

  // Sort by date descending
  reports.sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
  return reports;
}

/** Read a specific report JSON */
export function readReport(reportDir: string, ticker: string, dateMode: string): any | null {
  const filePath = path.join(reportDir, ticker, `${dateMode}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Read a detail file from the report's detail directory */
export function readDetail(reportDir: string, ticker: string, dateMode: string, subPath: string): any | null {
  const filePath = path.join(reportDir, ticker, dateMode, subPath);
  // Prevent path traversal
  const absBase = path.resolve(reportDir);
  const absFile = path.resolve(filePath);
  if (!absFile.startsWith(absBase)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Read all traces for a run_id from trace directories inside the report tree */
export function readTraces(reportDir: string, runId: string): any[] {
  if (!fs.existsSync(reportDir)) return [];

  const traces: any[] = [];
  const traceSubDirs = ["02_traces", "06_traces"];

  const tickerDirs = safeReaddir(reportDir);
  for (const ticker of tickerDirs) {
    const tickerPath = path.join(reportDir, ticker);
    if (!fs.statSync(tickerPath).isDirectory()) continue;

    const dateModeDirs = safeReaddir(tickerPath);
    for (const dm of dateModeDirs) {
      const dmPath = path.join(tickerPath, dm);
      if (!fs.statSync(dmPath).isDirectory()) continue;

      for (const traceSub of traceSubDirs) {
        const tracesDir = path.join(dmPath, traceSub);
        if (!fs.existsSync(tracesDir)) continue;

        // New layout: each run physically isolated under {tracesDir}/{runId}/,
        // so re-running the same ticker+date doesn't accumulate prior runs'
        // traces in one flat dir. When the per-run subdir exists, read it
        // directly (already isolated, no run_id filter needed). Otherwise fall
        // back to the legacy flat layout, filtering by run_id (which mixes runs).
        const runDir = path.join(tracesDir, runId);
        const isolated = fs.existsSync(runDir) && fs.statSync(runDir).isDirectory();
        const dir = isolated ? runDir : tracesDir;
        for (const file of safeReaddir(dir)) {
          if (!file.endsWith(".json") || file === "run_summary.json") continue;
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
            if (isolated || raw.run_id === runId) traces.push(raw);
          } catch {
            // skip malformed traces
          }
        }
      }
    }
  }

  traces.sort((a, b) => {
    // call_index is NOT unique within a run (parallel calls read traceLogger.count
    // before record() increments it), so it can't order the timeline. Sort by
    // meta.timestamp first (ISO 8601 sorts lexicographically = chronologically);
    // fall back to call_index only when a trace lacks a timestamp.
    const ta = a.meta?.timestamp || '';
    const tb = b.meta?.timestamp || '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (a.call_index ?? 0) - (b.call_index ?? 0);
  });
  return traces;
}

/** Read traces by ticker and date from trace directories inside the report tree */
export function readTracesByTickerDate(reportDir: string, ticker: string, date: string): any[] {
  if (!fs.existsSync(reportDir)) return [];

  const traces: any[] = [];
  const dateModes = [`${date}_quick`, `${date}_full`];
  const traceSubDirs = ["02_traces", "06_traces"];

  for (const dm of dateModes) {
    for (const traceSub of traceSubDirs) {
      const tracesDir = path.join(reportDir, ticker, dm, traceSub);
      if (!fs.existsSync(tracesDir)) continue;

      // Recurse one level: in the isolated layout each entry is a {runId}/
      // subdir; in the legacy layout entries are flat .json files. This is the
      // fallback path (no run_id), so it may still span runs — callers with a
      // run_id use readTraces() which isolates cleanly.
      for (const entry of safeReaddir(tracesDir)) {
        const entryPath = path.join(tracesDir, entry);
        let files: string[];
        try {
          files = fs.statSync(entryPath).isDirectory()
            ? safeReaddir(entryPath).map((f) => path.join(entryPath, f))
            : [entryPath];
        } catch {
          continue;
        }
        for (const filePath of files) {
          if (!filePath.endsWith(".json") || path.basename(filePath) === "run_summary.json") continue;
          try {
            traces.push(JSON.parse(fs.readFileSync(filePath, "utf-8")));
          } catch {
            // skip
          }
        }
      }
    }
  }

  traces.sort((a, b) => {
    // call_index is NOT unique within a run (parallel calls read traceLogger.count
    // before record() increments it), so it can't order the timeline. Sort by
    // meta.timestamp first (ISO 8601 sorts lexicographically = chronologically);
    // fall back to call_index only when a trace lacks a timestamp.
    const ta = a.meta?.timestamp || '';
    const tb = b.meta?.timestamp || '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (a.call_index ?? 0) - (b.call_index ?? 0);
  });
  return traces;
}

/** Read raw data source outputs from the report detail directory */
export function readDataSources(reportDir: string, ticker: string, dateMode: string): any[] {
  const detailDir = path.join(reportDir, ticker, dateMode);
  const dataSubDirs = ["03_data", "07_data"];

  for (const dataSub of dataSubDirs) {
    const dataDir = path.join(detailDir, dataSub);
    if (!fs.existsSync(dataDir)) continue;

    const results: any[] = [];
    const files = safeReaddir(dataDir);
    for (const file of files) {
      if (!file.endsWith("_raw.json")) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf-8"));
        results.push({ role: file.replace("_raw.json", ""), ...raw });
      } catch {
        // skip
      }
    }
    return results;
  }
  return [];
}

// ── Helpers ──────────────────────────────────────────────────

function toSummary(raw: any): ReportSummary {
  return {
    id: raw.id || "",
    run_id: raw.run_id,
    ticker: raw.ticker || "",
    company_name: raw.company_name || "",
    date: raw.date || "",
    mode: raw.mode || "quick",
    created_at: raw.created_at || "",
    duration_ms: raw.duration_ms || 0,
    total_tokens: raw.total_tokens || 0,
    total_cost_usd: raw.total_cost_usd || 0,
    direction: raw.final?.direction || "Hold",
    confidence: raw.final?.confidence || 0,
    analyst_verdicts: raw.analyst_verdicts || {},
    trace_count: raw.trace_count || 0,
    risk_assessment: raw.final?.risk_assessment,
    warnings: raw.warnings || [],
    cross_stage_issues: raw.cross_stage_issues || [],
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
