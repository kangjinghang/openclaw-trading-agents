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
exports.findLatestDiff = findLatestDiff;
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const candidates_1 = require("./watchlist/candidates");
const atomic_json_1 = require("./watchlist/atomic-json");
const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");
function readJson(fp) {
    if (!fs.existsSync(fp))
        return null;
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
}
/** diff 目录里日期最大的文件（= 最新 data_date 的 diff）。不存在返回 null。 */
function findLatestDiff(dir) {
    const diffDir = path.join(dir, "diff");
    if (!fs.existsSync(diffDir))
        return null;
    const dates = fs.readdirSync(diffDir)
        .map((f) => f.replace(/\.json$/, ""))
        .sort();
    return dates.length > 0 ? dates[dates.length - 1] : null;
}
function main() {
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
    const diff = readJson(path.join(watchlistDir, "diff", `${date}.json`));
    if (!diff) {
        console.error(`error: diff 不存在: ${date}`);
        console.error(`请先运行 npm run diff -- --date ${date}`);
        process.exit(1);
    }
    const candidates = (0, candidates_1.buildCandidates)(diff);
    const outFile = path.join(watchlistDir, "derived", `${date}-candidates.json`);
    (0, atomic_json_1.writeAtomicJson)(outFile, candidates);
    const daily = (0, candidates_1.buildDailyCandidates)(diff);
    const dailyOutFile = path.join(watchlistDir, "derived", `${date}-daily-candidates.json`);
    (0, atomic_json_1.writeAtomicJson)(dailyOutFile, daily);
    console.log(`候选清单生成: ${date}`);
    console.log(`  区间异动榜(up): ${candidates.up.length} → ${outFile}`);
    console.log(`  单日异动榜(up): ${daily.up.length} → ${dailyOutFile}`);
    const formatTrend = (c) => {
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
if (require.main === module)
    main();
//# sourceMappingURL=candidates-cli.js.map