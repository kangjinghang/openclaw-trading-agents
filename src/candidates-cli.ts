import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { buildCandidates } from "./watchlist/candidates";
import { writeAtomicJson } from "./watchlist/atomic-json";
import type { DiffFile, CandidatesFile, CandidateEntry } from "./watchlist/types";

const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");

function readJson<T>(fp: string): T | null {
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, "utf-8")) as T;
}

function main(): void {
  const args = process.argv.slice(2);
  const help = args.includes("--help") || args.includes("-h");
  const watchlistDir = process.env.WATCHLIST_DIR ?? DEFAULT_WATCHLIST_DIR;

  const dateIdx = args.indexOf("--date");
  const date = dateIdx >= 0 && args[dateIdx + 1] ? args[dateIdx + 1] : new Date().toISOString().split("T")[0];

  if (help) {
    console.log(`Usage: npm run candidates [-- --date <YYYY-MM-DD>]

Options:
  --date <D>    扫描日（默认今天）
  --help        显示帮助
  WATCHLIST_DIR 存储路径环境变量（默认 ${DEFAULT_WATCHLIST_DIR}）
`);
    process.exit(0);
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

  console.log(`候选清单生成: ${date}`);
  console.log(`  上涨候选(up): ${candidates.up.length}`);
  console.log(`  输出: ${outFile}`);

  const formatTrend = (c: CandidateEntry): string => {
    const pct = c.range.percent > 0 ? `+${c.range.percent}` : `${c.range.percent}`;
    const kind = c.range_kind === "continued" ? "延续" : "新出";
    const reasons = c.today_reasons.length > 0 ? ` +今日${c.today_reasons.length}条涨 reason` : "";
    return `${pct}% (${c.days}d, ${kind}${reasons})`;
  };
  console.log(`\n  上涨候选（前 10，按 持续长 > 幅度大）:`);
  for (const c of candidates.up.slice(0, 10)) {
    console.log(`    ${c.ticker} ${c.name}: ${formatTrend(c)}`);
  }
}

main();
