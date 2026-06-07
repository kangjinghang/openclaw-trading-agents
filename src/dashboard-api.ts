// src/dashboard-api.ts — API handlers for the dashboard server

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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
}

/** Scan report directory and return all report summaries */
export function listReports(reportDir: string): ReportSummary[] {
  const absDir = reportDir.replace("~", os.homedir());
  if (!fs.existsSync(absDir)) return [];

  const reports: ReportSummary[] = [];

  const tickerDirs = safeReaddir(absDir);
  for (const ticker of tickerDirs) {
    const tickerPath = path.join(absDir, ticker);
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
  const filePath = path.join(reportDir.replace("~", os.homedir()), ticker, `${dateMode}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Read a detail file from the report's detail directory */
export function readDetail(reportDir: string, ticker: string, dateMode: string, subPath: string): any | null {
  const filePath = path.join(reportDir.replace("~", os.homedir()), ticker, dateMode, subPath);
  // Prevent path traversal
  const absBase = path.resolve(reportDir.replace("~", os.homedir()));
  const absFile = path.resolve(filePath);
  if (!absFile.startsWith(absBase)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Read all traces for a run_id from the trace directory */
export function readTraces(runId: string): any[] {
  const tracesBase = path.join(os.homedir(), ".openclaw", "traces");
  if (!fs.existsSync(tracesBase)) return [];

  const traces: any[] = [];
  const dirs = safeReaddir(tracesBase);

  for (const dir of dirs) {
    const dirPath = path.join(tracesBase, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const files = safeReaddir(dirPath);
    for (const file of files) {
      if (!file.endsWith(".json") || file === "run_summary.json") continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dirPath, file), "utf-8"));
        if (raw.run_id === runId) {
          traces.push(raw);
        }
      } catch {
        // skip malformed traces
      }
    }
  }

  traces.sort((a, b) => (a.call_index ?? 0) - (b.call_index ?? 0));
  return traces;
}

/** Read traces by ticker and date (from trace directory name) */
export function readTracesByTickerDate(ticker: string, date: string): any[] {
  const tracesBase = path.join(os.homedir(), ".openclaw", "traces");
  // Try both quick and full trace dirs
  const dirs = [`${ticker}_${date}`, `${ticker}_${date}_full`];
  const traces: any[] = [];

  for (const dir of dirs) {
    const dirPath = path.join(tracesBase, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = safeReaddir(dirPath);
    for (const file of files) {
      if (!file.endsWith(".json") || file === "run_summary.json") continue;
      try {
        traces.push(JSON.parse(fs.readFileSync(path.join(dirPath, file), "utf-8")));
      } catch {
        // skip
      }
    }
  }

  traces.sort((a, b) => (a.call_index ?? 0) - (b.call_index ?? 0));
  return traces;
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
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
