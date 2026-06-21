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
exports.parseKline = parseKline;
exports.parseNews = parseNews;
exports.parseHotMoney = parseHotMoney;
exports.parseFundamentals = parseFundamentals;
exports.fetchStockData = fetchStockData;
exports.fetchAllStockData = fetchAllStockData;
const path = __importStar(require("path"));
const exec_python_1 = require("../exec-python");
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
/** 从 kline.py 输出解析 K 线摘要。容忍字段缺失。 */
function parseKline(raw) {
    const closes = Array.isArray(raw?.closes) ? raw.closes : [];
    if (closes.length < 2)
        return { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0 };
    const last = closes[closes.length - 1];
    const ago5 = closes.length > 5 ? closes[closes.length - 6] : closes[0];
    const ago20 = closes.length > 20 ? closes[closes.length - 21] : closes[0];
    const recent = closes.slice(-5);
    return {
        pct_5d: ago5 > 0 ? (last - ago5) / ago5 * 100 : 0,
        pct_20d: ago20 > 0 ? (last - ago20) / ago20 * 100 : 0,
        support: Math.min(...recent),
        resistance: Math.max(...recent),
    };
}
function parseNews(raw) {
    if (!Array.isArray(raw?.news))
        return [];
    return raw.news.slice(0, 5).map((n) => typeof n?.title === "string" ? n.title : "").filter(Boolean);
}
function parseHotMoney(raw) {
    return { net_5d: typeof raw?.net_5d === "number" ? raw.net_5d : 0 };
}
function parseFundamentals(raw) {
    return {
        pe: typeof raw?.pe_ttm === "number" ? raw.pe_ttm : (typeof raw?.pe === "number" ? raw.pe : 0),
        pb: typeof raw?.pb === "number" ? raw.pb : 0,
        rev_q1: typeof raw?.revenue_q1 === "number" ? raw.revenue_q1 : (typeof raw?.rev_q1 === "number" ? raw.rev_q1 : 0),
        np_q1: typeof raw?.net_profit_q1 === "number" ? raw.net_profit_q1 : (typeof raw?.np_q1 === "number" ? raw.np_q1 : 0),
    };
}
/** 单股并行跑 4 个 script。失败的 script 返回 null 字段（容忍）。 */
async function fetchStockData(ticker, name, sector, rankerThesis) {
    const tasks = [
        safeCall(() => (0, exec_python_1.execSkillScript)("trading-kline", "kline", PROJECT_ROOT, [ticker])),
        safeCall(() => (0, exec_python_1.execSkillScript)("trading-news", "news", PROJECT_ROOT, [ticker])),
        safeCall(() => (0, exec_python_1.execSkillScript)("trading-hot-money", "hot_money", PROJECT_ROOT, [ticker])),
        safeCall(() => (0, exec_python_1.execSkillScript)("trading-fundamentals", "fundamentals", PROJECT_ROOT, [ticker])),
    ];
    const [klineR, newsR, hotR, fundR] = await Promise.all(tasks);
    const kline = klineR ? parseKline(klineR) : { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0 };
    const news = newsR ? parseNews(newsR) : [];
    const hot = hotR ? parseHotMoney(hotR) : { net_5d: 0 };
    const fund = fundR ? parseFundamentals(fundR) : { pe: 0, pb: 0, rev_q1: 0, np_q1: 0 };
    return {
        ticker, name, sector,
        kline, news,
        hot_money: hot,
        fundamentals: fund,
        ranker_thesis: rankerThesis,
    };
}
/** 安全调用 execSkillScript，失败返回 null。返回 data 字段（已 JSON 解析）。 */
async function safeCall(fn) {
    try {
        const result = await fn();
        if (!result || !result.success)
            return null;
        return result.data;
    }
    catch {
        return null;
    }
}
/** 跨股并行 fetch（concurrency=5）。失败的股跳过。 */
async function fetchAllStockData(metas, concurrency = 5) {
    const result = new Map();
    const queue = [...metas];
    const workers = [];
    for (let w = 0; w < concurrency; w++) {
        workers.push((async () => {
            while (queue.length > 0) {
                const meta = queue.shift();
                try {
                    const data = await fetchStockData(meta.ticker, meta.name, meta.sector, meta.ranker_thesis);
                    if (data)
                        result.set(meta.ticker, data);
                }
                catch {
                    // 跳过失败的股
                }
            }
        })());
    }
    await Promise.all(workers);
    return result;
}
//# sourceMappingURL=data-fetcher.js.map