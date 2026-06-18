import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { computeDiff, computeDataDateMs } from "./watchlist/diff";
import { writeAtomicJson } from "./watchlist/atomic-json";
import type { RawSnapshotFile, DiffFile } from "./watchlist/types";

const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");

function readRaw(date: string, dir: string): RawSnapshotFile | null {
  const fp = path.join(dir, "raw", `${date}.json`);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, "utf-8")) as RawSnapshotFile;
}

function findLatestBaseline(today: string, dir: string): string | null {
  const rawDir = path.join(dir, "raw");
  if (!fs.existsSync(rawDir)) return null;
  const dates = fs.readdirSync(rawDir)
    .map((f) => f.replace(/\.json$/, ""))
    .filter((d) => d < today)
    .sort();
  return dates.length > 0 ? dates[dates.length - 1] : null;
}

/** raw 目录里日期最大的快照（= 最新 data_date）。目录不存在或空返回 null。 */
export function findLatestSnapshot(dir: string): string | null {
  const rawDir = path.join(dir, "raw");
  if (!fs.existsSync(rawDir)) return null;
  const dates = fs.readdirSync(rawDir)
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
  return dates.length > 0 ? dates[dates.length - 1] : null;
}

function main(): void {
  const args = process.argv.slice(2);
  const help = args.includes("--help") || args.includes("-h");
  const watchlistDir = process.env.WATCHLIST_DIR ?? DEFAULT_WATCHLIST_DIR;

  const dateIdx = args.indexOf("--date");
  const date = dateIdx >= 0 && args[dateIdx + 1] ? args[dateIdx + 1] : findLatestSnapshot(watchlistDir);

  const baselineIdx = args.indexOf("--baseline");
  const explicitBaseline = baselineIdx >= 0 ? args[baselineIdx + 1] : undefined;

  if (help) {
    console.log(`Usage: npm run diff [-- --date <YYYY-MM-DD>] [-- --baseline <YYYY-MM-DD>]

Options:
  --date <D>        扫描日（默认最新快照）
  --baseline <D>    基线快照日（默认最近可用）
  --help            显示帮助
  WATCHLIST_DIR     存储路径环境变量（默认 ${DEFAULT_WATCHLIST_DIR})
`);
    process.exit(0);
  }

  if (!date) {
    console.error(`error: 没有任何快照，请先运行 npm run snapshot`);
    process.exit(1);
  }

  const today = readRaw(date, watchlistDir);
  if (!today) {
    console.error(`error: 今日快照不存在: ${path.join(watchlistDir, "raw", `${date}.json`)}`);
    console.error(`请先运行 npm run snapshot -- --date ${date}`);
    process.exit(1);
  }

  const baselineDate = explicitBaseline ?? findLatestBaseline(date, watchlistDir);
  const baseline = baselineDate ? readRaw(baselineDate, watchlistDir) : null;

  if (explicitBaseline && !baseline) {
    console.error(`error: 指定的基线快照不存在: ${baselineDate}`);
    process.exit(1);
  }

  const diff: DiffFile = computeDiff(today, baseline);
  const outDir = path.join(watchlistDir, "diff");
  const outFile = path.join(outDir, `${date}.json`);
  writeAtomicJson(outFile, diff);

  // 滞后检测：锚点（雪球数据视角的最新交易日）若显著早于 scan_date，说明雪球当天
  // 还没更新数据（盘前跑了 / 节假日 / 接口延迟），diff 选出的"今天仍在延续的趋势"
  // 实际是几天前的。给个 warning，提示用户盘后重跑。
  const dataDateMs = computeDataDateMs(today);
  if (dataDateMs > 0) {
    const scanMs = Date.parse(date + "T00:00:00+08:00");
    const lagDays = Math.round((scanMs - dataDateMs) / (24 * 60 * 60 * 1000));
    if (lagDays >= 3) {
      const dataDate = new Date(dataDateMs).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
      console.error(`  ⚠ 雪球数据最新日为 ${dataDate}，比 scan_date ${date} 早 ${lagDays} 天`);
      console.error(`    可能是盘前运行或接口延迟；建议收盘后（约 20:00）重跑 snapshot + diff`);
    }
  }

  console.log(`diff 完成: ${date} vs ${baseline?.scan_date ?? "(首次扫描)"}`);
  console.log(`  变更股票数: ${diff.changes.length}`);
  console.log(`  输出: ${outFile}`);

  if (diff.changes.length > 0) {
    console.log("\n  前 10 个变更:");
    for (const c of diff.changes.slice(0, 10)) {
      const r = c.today_reason_points.length;
      const cont = c.continued_ranges.length;
      const nw = c.new_ranges.length;
      console.log(`    ${c.ticker} ${c.name}: ${r}异动点, ${cont}延续, ${nw}新区间`);
    }
    if (diff.changes.length > 10) console.log(`    ... 还有 ${diff.changes.length - 10} 个`);
  }
}

if (require.main === module) main();
