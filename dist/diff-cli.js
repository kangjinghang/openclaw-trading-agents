"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const diff_1 = require("./watchlist/diff");
const atomic_json_1 = require("./watchlist/atomic-json");
const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");
function readRaw(date, dir) {
    const fp = path.join(dir, "raw", `${date}.json`);
    if (!fs.existsSync(fp))
        return null;
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
}
function findLatestBaseline(today, dir) {
    const rawDir = path.join(dir, "raw");
    if (!fs.existsSync(rawDir))
        return null;
    const dates = fs.readdirSync(rawDir)
        .map((f) => f.replace(/\.json$/, ""))
        .filter((d) => d < today)
        .sort();
    return dates.length > 0 ? dates[dates.length - 1] : null;
}
function main() {
    const args = process.argv.slice(2);
    const help = args.includes("--help") || args.includes("-h");
    const watchlistDir = process.env.WATCHLIST_DIR ?? DEFAULT_WATCHLIST_DIR;
    const dateIdx = args.indexOf("--date");
    const date = dateIdx >= 0 && args[dateIdx + 1] ? args[dateIdx + 1] : new Date().toISOString().split("T")[0];
    const baselineIdx = args.indexOf("--baseline");
    const explicitBaseline = baselineIdx >= 0 ? args[baselineIdx + 1] : undefined;
    if (help) {
        console.log(`Usage: npm run diff [-- --date <YYYY-MM-DD>] [-- --baseline <YYYY-MM-DD>]

Options:
  --date <D>        扫描日（默认今天）
  --baseline <D>    基线快照日（默认最近可用）
  --help            显示帮助
  WATCHLIST_DIR     存储路径环境变量（默认 ${DEFAULT_WATCHLIST_DIR}）
`);
        process.exit(0);
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
    const diff = (0, diff_1.computeDiff)(today, baseline);
    const outDir = path.join(watchlistDir, "diff");
    const outFile = path.join(outDir, `${date}.json`);
    (0, atomic_json_1.writeAtomicJson)(outFile, diff);
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
        if (diff.changes.length > 10)
            console.log(`    ... 还有 ${diff.changes.length - 10} 个`);
    }
}
main();
//# sourceMappingURL=diff-cli.js.map