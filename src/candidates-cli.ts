import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { buildCandidates } from "./watchlist/candidates";
import { writeAtomicJson } from "./watchlist/atomic-json";
import type { RawSnapshotFile, DiffFile, CandidatesFile, CandidateEntry } from "./watchlist/types";

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

  const rawToday = readJson<RawSnapshotFile>(path.join(watchlistDir, "raw", `${date}.json`));
  if (!rawToday) {
    console.error(`error: 今日快照不存在: ${date}`);
    process.exit(1);
  }

  const candidates: CandidatesFile = buildCandidates(diff, rawToday);
  const outFile = path.join(watchlistDir, "derived", `${date}-candidates.json`);
  writeAtomicJson(outFile, candidates);

  const total = candidates.up.length + candidates.down.length + candidates.neutral.length;
  console.log(`候选清单生成: ${date}`);
  console.log(`  总数: ${total} | 上涨(up): ${candidates.up.length} | 下跌(down): ${candidates.down.length} | 仅异动(neutral): ${candidates.neutral.length}`);
  console.log(`  输出: ${outFile}`);

  // type(LONG/SHORT) 只是雪球的分析窗口长度，非涨跌方向；涨跌看 percent 正负。
  const formatTrend = (c: CandidateEntry): string => {
    const t = c.top_trend;
    return t ? `${t.percent > 0 ? "+" : ""}${t.percent}% (${t.days}d${t.ongoing ? ",进行中" : ""})` : "无区间趋势";
  };
  const showGroup = (label: string, group: CandidateEntry[]): void => {
    if (group.length === 0) return;
    console.log(`\n  ${label}（前 10，按 进行中 > 持续长 > 幅度大）:`);
    for (const c of group.slice(0, 10)) {
      console.log(`    ${c.ticker} ${c.name}: ${formatTrend(c)} | 今日+${c.new_today.reasons}异动 +${c.new_today.ranges}区间`);
    }
  };
  // 上涨候选最值得关注（找做多机会），优先展示 up，其次 down（规避/卖点）
  showGroup("上涨候选", candidates.up);
  showGroup("下跌候选", candidates.down);
}

main();
