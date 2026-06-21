import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { buildCandidates, buildDailyCandidates } from "./watchlist/candidates";
import { writeAtomicJson } from "./watchlist/atomic-json";
import type { DiffFile, CandidatesFile, CandidateEntry, DailyCandidatesFile } from "./watchlist/types";

const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");

function readJson<T>(fp: string): T | null {
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, "utf-8")) as T;
}

/** diff 目录里日期最大的文件（= 最新 data_date 的 diff）。不存在返回 null。 */
export function findLatestDiff(dir: string): string | null {
  const diffDir = path.join(dir, "diff");
  if (!fs.existsSync(diffDir)) return null;
  const dates = fs.readdirSync(diffDir)
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
  return dates.length > 0 ? dates[dates.length - 1] : null;
}

function main(): void {
  const args = process.argv.slice(2);
  const help = args.includes("--help") || args.includes("-h");
  const watchlistDir = process.env.WATCHLIST_DIR ?? DEFAULT_WATCHLIST_DIR;

  const dateIdx = args.indexOf("--date");
  const date = dateIdx >= 0 && args[dateIdx + 1] ? args[dateIdx + 1] : findLatestDiff(watchlistDir);

  if (help) {
    console.log(`Usage: npm run candidates [-- --date <YYYY-MM-DD>]

Options:
  --date <D>    扫描日（默认最新 diff）
  --help        显示帮助
  WATCHLIST_DIR 存储路径环境变量（默认 ${DEFAULT_WATCHLIST_DIR})
`);
    process.exit(0);
  }

  if (!date) {
    console.error(`error: 没有任何 diff，请先运行 npm run diff`);
    process.exit(1);
  }

  const diff = readJson<DiffFile>(path.join(watchlistDir, "diff", `${date}.json`));
  if (!diff) {
    console.error(`error: diff 不存在: ${date}`);
    console.error(`请先运行 npm run diff -- --date ${date}`);
    process.exit(1);
  }

  const candidates: CandidatesFile = buildCandidates(diff);
  const outFile = path.join(watchlistDir, "derived", `${date}-candidates.json`);
  writeAtomicJson(outFile, candidates);

  const daily: DailyCandidatesFile = buildDailyCandidates(diff);
  const dailyOutFile = path.join(watchlistDir, "derived", `${date}-daily-candidates.json`);
  writeAtomicJson(dailyOutFile, daily);

  console.log(`候选清单生成: ${date}`);
  console.log(`  区间异动榜(up): ${candidates.up.length} → ${outFile}`);
  console.log(`  单日异动榜(up): ${daily.up.length} → ${dailyOutFile}`);

  const formatTrend = (c: CandidateEntry): string => {
    const pct = c.range.percent > 0 ? `+${c.range.percent}` : `${c.range.percent}`;
    const kind = c.range_kind === "continued" ? "延续" : "新出";
    // 区间事件链中 timestamp === range.end（= 今日）的就是今日异动
    const todayCount = c.range_events.filter(r => r.timestamp === c.range.end).length;
    const today = todayCount > 0 ? ` +今日${todayCount}条` : "";
    const chain = c.range_events.length > 0 ? ` 区间事件${c.range_events.length}条` : "";
    return `${pct}% (${c.days}d, ${kind}${today}${chain})`;
  };
  console.log(`\n  上涨候选（前 10，按 持续长 > 幅度大）:`);
  for (const c of candidates.up.slice(0, 10)) {
    console.log(`    ${c.ticker} ${c.name}: ${formatTrend(c)}`);
  }
}

if (require.main === module) main();
