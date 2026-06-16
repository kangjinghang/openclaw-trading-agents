// src/source-health-cli.ts
// Standalone CLI for inspecting cross-run data source health.
//
// Usage:
//   npm run source-health                          # 表格输出（默认，全历史）
//   npm run source-health -- --period 7d           # 最近 7 天
//   npm run source-health -- --period=30d          # 最近 30 天（等号语法）
//   npm run source-health -- --period all          # 全历史（与默认一致）
//   npm run source-health -- --json                # JSON 输出（脚本友好）
//   npm run source-health -- --failing             # 只看最近有失败的 source
//   npm run source-health -- --json --period 30d   # 组合
//   REPORT_DIR=/custom/path npm run source-health  # 自定义 report 路径
//
// Reads ~/.openclaw/trading-reports/_source-health.json by default.
//
// Period semantics: the ring buffer covers ~1+ year (BUFFER_SIZE = 2000/source).
// `--period 7d` filters each source's history to ts >= (now - 7d) before
// recomputing stats, so the CLI shows long-term stability trends. Without
// `--period` the full buffer is used (same as before this feature shipped).

import * as os from "os";
import * as path from "path";
import {
  SourceHealthStore,
  computeStats,
  parsePeriod,
  filterHistorySince,
  type SourceHealthFile,
  type SourceHealthEntry,
} from "./source-health-store";

const DEFAULT_REPORT_DIR = path.join(os.homedir(), ".openclaw", "trading-reports");

const VALID_PERIODS = ["3d", "7d", "30d", "90d", "1y", "all"];

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

/**
 * Human-readable label for the table title. Returns the *original* token so
 * callers see exactly what they passed (e.g. `--period=1w` → "last 1 week").
 * Falls back to "all time" for null.
 */
function periodLabel(periodStr: string | null): string {
  if (periodStr === null) return "all time";
  const match = /^(\d+)([dwmy])$/.exec(periodStr);
  if (!match) return "all time";
  const n = Number(match[1]);
  const unitWord: Record<string, string> = { d: "day", w: "week", m: "month", y: "year" };
  const plural = n === 1 ? "" : "s";
  return `last ${n} ${unitWord[match[2]]}${plural}`;
}

/**
 * Recompute per-source entry with stats derived from period-filtered history.
 * Returns the original entry if no `since` filter is given. Records a flag
 * `periodEmpty` (caller-visible only via return value) when the period filter
 * leaves zero records — used to render `(no data in period)` rows.
 */
interface PeriodFilteredEntry extends SourceHealthEntry {
  /** True when `since` filtering left zero records in this source's window. */
  periodEmpty?: boolean;
}

function applyPeriodToSources(
  state: SourceHealthFile,
  since: string | null,
): Record<string, PeriodFilteredEntry> {
  const out: Record<string, PeriodFilteredEntry> = {};
  for (const [name, entry] of Object.entries(state.sources)) {
    if (since === null) {
      out[name] = entry;
      continue;
    }
    const filtered = filterHistorySince(entry.history, since);
    out[name] = {
      history: entry.history, // preserve raw history for --json consumers
      stats: computeStats(filtered),
      periodEmpty: filtered.length === 0,
    };
  }
  return out;
}

function renderTable(
  state: SourceHealthFile,
  reportDir: string,
  periodStr: string | null,
  since: string | null,
): void {
  const sources = Object.entries(state.sources);
  if (sources.length === 0) {
    console.log("No data source health records yet.");
    console.log(`Run trading_quick/full first — file would appear at ${path.join(reportDir, "_source-health.json")}`);
    return;
  }

  const label = periodLabel(periodStr);
  console.log(`\n  Data source health (${label}, cross-run)\n`);
  console.log(`  Path:   ${path.join(reportDir, "_source-health.json")}`);
  console.log(`  Updated: ${state.updated_at || "(never)"}\n`);

  const filtered = applyPeriodToSources(state, since);

  const header =
    "SOURCE".padEnd(28) +
    "SUCCESS".padStart(10) +
    "RATE".padStart(8) +
    "  LAST_ERROR".padEnd(22) +
    "LAST_CALL".padStart(12);
  console.log("  " + header);
  console.log("  " + "-".repeat(header.length));

  for (const [name, entry] of Object.entries(filtered)) {
    let line: string;
    if (entry.periodEmpty) {
      const padTotal = 10 + 8; // SUCCESS + RATE columns
      line =
        name.padEnd(26) +
        "(no data in period)".padStart(padTotal + 2) +
        "  ".padEnd(22) +
        "".padStart(12);
    } else {
      const s = entry.stats;
      const succ = `${s.total_success}/${s.total_calls}`;
      const rate = `(${(s.success_rate * 100).toFixed(0)}%)`;
      const lastErr = (s.last_error || "-").slice(0, 20);
      const lastTs = s.last_success_ts ?? s.last_error_ts;
      const lastCall = lastTs ? formatRelative(lastTs) : "(never)";
      const indicator = s.success_rate < 1 ? "! " : "  ";
      line =
        indicator +
        name.padEnd(26) +
        succ.padStart(10) +
        rate.padStart(8) +
        "  " +
        lastErr.padEnd(22) +
        lastCall.padStart(12);
    }
    console.log("  " + line);
  }

  console.log(
    "\n  Legend: '!' = at least one failure in period. Use --json for raw data, --failing to filter.",
  );
  if (since !== null) {
    console.log(`  Period filter: since ${since}`);
  }
}

function renderFailing(
  state: SourceHealthFile,
  since: string | null,
): void {
  const filtered = applyPeriodToSources(state, since);
  // `--failing` skips sources with 0 calls in the period (they're not
  // "recently failing", just absent).
  const failing = Object.entries(filtered).filter(
    ([_, e]) => !e.periodEmpty && e.stats.success_rate < 1,
  );
  if (failing.length === 0) {
    console.log("\n  No data sources with recent failures in the selected period.\n");
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

/** Extract `--period <X>` or `--period=<X>` from argv. Returns null/undefined per parsePeriod. */
function extractPeriodArg(args: string[]): string | undefined {
  const eqFormIdx = args.findIndex((a) => a.startsWith("--period="));
  if (eqFormIdx >= 0) {
    return args[eqFormIdx].slice("--period=".length);
  }
  const spaceFormIdx = args.indexOf("--period");
  if (spaceFormIdx >= 0 && spaceFormIdx + 1 < args.length) {
    return args[spaceFormIdx + 1];
  }
  return undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const failingOnly = args.includes("--failing");
  const help = args.includes("--help") || args.includes("-h");
  const reportDir = process.env.REPORT_DIR ?? DEFAULT_REPORT_DIR;

  // Period: undefined means "not provided" (→ all); a value means it was
  // explicitly passed (even "all") and we should validate it.
  const periodArgPresent =
    args.some((a) => a.startsWith("--period=")) || args.includes("--period");
  const periodRaw = extractPeriodArg(args);

  // Explicit `--period` with no following token → missing-value error.
  if (periodArgPresent && periodRaw === undefined) {
    console.error(
      `error: --period requires a value. Valid: ${VALID_PERIODS.join(" | ")}`,
    );
    process.exit(1);
  }

  const sinceParsed = parsePeriod(periodRaw);

  // User explicitly passed `--period <X>` but it failed to parse → reject loudly.
  if (periodArgPresent && sinceParsed === undefined) {
    console.error(
      `error: invalid --period value '${periodRaw}'. Valid: ${VALID_PERIODS.join(" | ")}`,
    );
    process.exit(1);
  }

  // After the guards above (and `periodRaw === undefined` only when --period
  // is absent), `sinceParsed` is guaranteed to be `string | null` here.
  const since: string | null = sinceParsed ?? null;
  const periodStr = periodArgPresent ? periodRaw ?? "all" : null;

  if (help) {
    console.log(`Usage: npm run source-health [-- --json | --failing | --period <P> | --help]

Options:
  --json               Emit raw JSON (script-friendly)
  --failing            Only show sources with at least one recent failure
  --period <P>         Filter stats to a time window (default: all)
                       P = 3d | 7d | 30d | 90d | 1y | all
                       (also accepts 1w / 6m / 180d / etc; aliases: w=7d, m=30d, y=365d)
  --help               Show this help
  REPORT_DIR           Env var overriding report directory (default: ${DEFAULT_REPORT_DIR})

Examples:
  npm run source-health -- --period 7d
  npm run source-health -- --period=30d --json
  npm run source-health -- --failing --period 30d
`);
    process.exit(0);
  }

  const store = new SourceHealthStore(reportDir);
  const state = store.read();

  if (asJson) {
    // Recompute per-source stats on the filtered history; keep raw `history`
    // intact so JSON consumers can recompute for any other period. Top-level
    // `period` block records what filter was applied.
    const filtered = applyPeriodToSources(state, since);
    const out: SourceHealthFile & { period?: { filter: string; since: string | null } } = {
      ...state,
      sources: Object.fromEntries(
        Object.entries(filtered).map(([name, e]) => [
          name,
          { history: e.history, stats: e.stats },
        ]),
      ),
    };
    if (periodStr !== null) {
      out.period = { filter: periodStr, since };
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (failingOnly) {
    renderFailing(state, since);
  } else {
    renderTable(state, reportDir, periodStr, since);
  }
}

main();
