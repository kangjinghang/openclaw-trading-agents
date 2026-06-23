"use strict";
// src/fitness-history-cli.ts
// fitness 回测分析入口：读 fitness-history.json，按 fitness 分桶统计事后收益。
// 用法：npm run fitness-history [-- --json --min-samples 5 --action BUY]
//
// 这是 1-3 个月后的回测入口。系统跑够时间积累了 settled 记录后，
// 这里输出"分数9的平均30天收益 X% vs 分数7的 Y%"，据此校准 position-calculator 基础档。
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
const fitness_history_store_1 = require("./watchlist/fitness-history-store");
const DEFAULT_WATCHLIST_DIR = path.join(os.homedir(), ".openclaw", "watchlist");
function argValue(args, key) {
    const idx = args.indexOf(key);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}
function bucket(fitness) {
    if (fitness >= 9)
        return "9-10";
    if (fitness >= 8)
        return "8-8.9";
    if (fitness >= 7)
        return "7-7.9";
    if (fitness >= 6)
        return "6-6.9";
    return "≤5";
}
const BUCKET_ORDER = ["9-10", "8-8.9", "7-7.9", "6-6.9", "≤5"];
function stats(records, minSamples) {
    const out = {};
    for (const b of BUCKET_ORDER)
        out[b] = { count: 0, avg30d: null, avg14d: null, avg7d: null };
    const byBucket = {};
    for (const b of BUCKET_ORDER)
        byBucket[b] = [];
    for (const r of records) {
        byBucket[bucket(r.fitness)].push(r);
    }
    for (const b of BUCKET_ORDER) {
        const recs = byBucket[b];
        out[b].count = recs.length;
        if (recs.length < minSamples)
            continue; // 样本不足，不计算均值
        const avg = (key) => {
            const vals = recs.map(r => r[key]).filter((v) => typeof v === "number");
            if (vals.length < minSamples)
                return null;
            return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10;
        };
        out[b].avg30d = avg("return_30d");
        out[b].avg14d = avg("return_14d");
        out[b].avg7d = avg("return_7d");
    }
    return out;
}
function main() {
    const args = process.argv.slice(2);
    const watchlistDir = process.env.WATCHLIST_DIR ?? DEFAULT_WATCHLIST_DIR;
    const json = args.includes("--json");
    const minSamples = parseInt(argValue(args, "--min-samples") ?? "5", 10);
    const actionFilter = argValue(args, "--action"); // 只看某 action（如 BUY）
    const store = new fitness_history_store_1.FitnessHistoryStore(watchlistDir);
    const file = store.read();
    let records = file.records.filter(r => r.status === "settled");
    if (actionFilter)
        records = records.filter(r => r.action === actionFilter);
    if (json) {
        console.log(JSON.stringify({
            total_records: file.records.length,
            settled: records.length,
            open: file.records.filter(r => r.status === "open").length,
            buckets: stats(records, minSamples),
        }, null, 2));
        return;
    }
    console.log(`\n=== fitness 回测分析 ===`);
    console.log(`  总记录: ${file.records.length}（settled ${records.length} / open ${file.records.filter(r => r.status === "open").length}）`);
    if (actionFilter)
        console.log(`  action 过滤: ${actionFilter}`);
    console.log(`  最小样本: ${minSamples}（不足则不显示均值）\n`);
    const s = stats(records, minSamples);
    console.log("fitness 桶 | 样本数 | 7天收益 | 14天收益 | 30天收益");
    console.log("-----------|--------|---------|----------|---------");
    for (const b of BUCKET_ORDER) {
        const st = s[b];
        const fmt = (v) => v === null ? "-" : `${v > 0 ? "+" : ""}${v}%`;
        console.log(`${b.padEnd(10)} | ${String(st.count).padEnd(6)} | ${fmt(st.avg7d).padEnd(7)} | ${fmt(st.avg14d).padEnd(8)} | ${fmt(st.avg30d)}`);
    }
    console.log(`\n  解读：比较"分数9-10桶" vs "分数7-7.9桶"的 30天收益。`);
    console.log(`  若高分桶明显跑赢低分桶 → fitness 预测力有效，position-calculator 档位合理。`);
    console.log(`  若无明显差异 → fitness 校准需调整（参考 docs/fitness-backtest-design）。`);
    console.log(`  （样本需积累 1-3 个月才有统计意义，当前 settled=${records.length}）`);
}
main();
//# sourceMappingURL=fitness-history-cli.js.map