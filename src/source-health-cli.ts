// src/source-health-cli.ts
// Standalone CLI for inspecting cross-run data source health.
//
// Usage:
//   npm run source-health              # 表格输出（默认）
//   npm run source-health -- --json    # JSON 输出（脚本友好）
//   npm run source-health -- --failing # 只看最近有失败的 source
//   REPORT_DIR=/custom/path npm run source-health   # 自定义 report 路径
//
// Reads ~/.openclaw/trading-reports/_source-health.json by default.

import * as os from "os";
import * as path from "path";
import { SourceHealthStore, type SourceHealthFile } from "./source-health-store";

const DEFAULT_REPORT_DIR = path.join(os.homedir(), ".openclaw", "trading-reports");

function formatRelative(isoTs: string): string {
  const then = new Date(isoTs).getTime();
  if (Number.isNaN(then)) return "(unknown)";
  const min = Math.floor((Date.now() - then) / 60000);
  if (min < 0) return "(future?)";
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function renderTable(state: SourceHealthFile, reportDir: string): void {
  const sources = Object.entries(state.sources);
  if (sources.length === 0) {
    console.log("No data source health records yet.");
    console.log(`Run trading_quick/full first — file would appear at ${path.join(reportDir, "_source-health.json")}`);
    return;
  }

  console.log("\n  Data source health (last N calls per source, cross-run)\n");
  console.log(`  Path:   ${path.join(reportDir, "_source-health.json")}`);
  console.log(`  Updated: ${state.updated_at || "(never)"}\n`);

  const header =
    "SOURCE".padEnd(28) +
    "SUCCESS".padStart(10) +
    "RATE".padStart(8) +
    "  LAST_ERROR".padEnd(22) +
    "LAST_CALL".padStart(12);
  console.log("  " + header);
  console.log("  " + "-".repeat(header.length));

  for (const [name, entry] of sources) {
    const s = entry.stats;
    const succ = `${s.total_success}/${s.total_calls}`;
    const rate = `(${(s.success_rate * 100).toFixed(0)}%)`;
    const lastErr = (s.last_error || "-").slice(0, 20);
    const lastTs = s.last_success_ts ?? s.last_error_ts;
    const lastCall = lastTs ? formatRelative(lastTs) : "(never)";
    const indicator = s.success_rate < 1 ? "! " : "  ";
    console.log(
      "  " +
        indicator +
        name.padEnd(26) +
        succ.padStart(10) +
        rate.padStart(8) +
        "  " +
        lastErr.padEnd(22) +
        lastCall.padStart(12),
    );
  }

  console.log(
    "\n  Legend: '!' = at least one recent failure. Use --json for raw data, --failing to filter.",
  );
}

function renderFailing(state: SourceHealthFile, reportDir: string): void {
  const failing = Object.entries(state.sources).filter(
    ([_, e]) => e.stats.success_rate < 1,
  );
  if (failing.length === 0) {
    console.log("\n  No data sources with recent failures.\n");
    return;
  }
  console.log("\n  Data sources with at least one recent failure:\n");
  for (const [name, entry] of failing) {
    const s = entry.stats;
    const succ = `${s.total_success}/${s.total_calls} (${(s.success_rate * 100).toFixed(0)}%)`;
    console.log(
      `  ${name.padEnd(28)} ${succ.padStart(16)}  last_err: ${(s.last_error || "-").slice(0, 30)}`,
    );
  }
  console.log("");
}

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const failingOnly = args.includes("--failing");
  const help = args.includes("--help") || args.includes("-h");
  const reportDir = process.env.REPORT_DIR ?? DEFAULT_REPORT_DIR;

  if (help) {
    console.log(`Usage: npm run source-health [-- --json | --failing | --help]

Options:
  --json      Emit raw JSON (script-friendly)
  --failing   Only show sources with at least one recent failure
  --help      Show this help
  REPORT_DIR  Env var overriding report directory (default: ${DEFAULT_REPORT_DIR}
`);
    process.exit(0);
  }

  const store = new SourceHealthStore(reportDir);
  const state = store.read();

  if (asJson) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  if (failingOnly) {
    renderFailing(state, reportDir);
  } else {
    renderTable(state, reportDir);
  }
}

main();
