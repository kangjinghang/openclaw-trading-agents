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
exports.computeVolumeRatio = computeVolumeRatio;
exports.parseKline = parseKline;
exports.parseNews = parseNews;
exports.parseHotMoney = parseHotMoney;
exports.parseFundamentals = parseFundamentals;
exports.fetchStockData = fetchStockData;
exports.fetchAllStockData = fetchAllStockData;
const path = __importStar(require("path"));
const exec_python_1 = require("../exec-python");
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
/** 从 kline.py 输出抽取收盘价数组。
 *  kline.py 实际输出 `{data: [{close, open, ...}]}`（对象数组），exec-python.ts:277
 *  把 raw.data 提到顶层。老测试用扁平 `raw.closes`，保留兼容。 */
function extractCloses(raw) {
    // 优先：kline.py 真实结构（对象数组，每条带 close）
    if (Array.isArray(raw?.data)) {
        const fromData = raw.data
            .map((row) => (row && typeof row.close === "number") ? row.close : NaN)
            .filter((c) => !isNaN(c));
        if (fromData.length > 0)
            return fromData;
    }
    // 兼容：扁平 closes 数组（老测试 / 未来其他脚本）
    if (Array.isArray(raw?.closes)) {
        return raw.closes.filter((c) => typeof c === "number" && !isNaN(c));
    }
    return [];
}
/** 从 kline.py 输出抽取成交量数组（与 extractCloses 同源 raw.data，读 row.volume）。
 *  无 volume 数据（如老格式扁平 closes）返回空数组。 */
function extractVolumes(raw) {
    if (Array.isArray(raw?.data)) {
        const fromData = raw.data
            .map((row) => (row && typeof row.volume === "number") ? row.volume : NaN)
            .filter((v) => !isNaN(v));
        if (fromData.length > 0)
            return fromData;
    }
    return []; // 扁平 closes 格式无 volume，不设 fallback
}
/** 计算最近 N 日的日收益率标准差（波动率，单位 %）。
 *  数据不足或价格异常返回 0（容忍）。 */
function computeVolatility(closes, windowDays = 20) {
    if (closes.length < windowDays + 1)
        return 0;
    const slice = closes.slice(-(windowDays + 1)); // 需要 N+1 个点算 N 个收益率
    const returns = [];
    for (let i = 1; i < slice.length; i++) {
        const prev = slice[i - 1];
        if (prev > 0)
            returns.push((slice[i] - prev) / prev * 100);
    }
    if (returns.length < 2)
        return 0;
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
}
/** 量比：近 recentDays 日均量 / 前 windowDays 日均量。
 *  典型用法：computeVolumeRatio(volumes, 5) = 近5日均量 / 20日均量。
 *  - ratio < 0.8 → 缩量（趋势可能衰竭，量价背离风险）
 *  - ratio > 1.2 → 放量（资金关注）
 *  数据不足（< recentDays + windowDays）或除零 → 0（容忍）。 */
function computeVolumeRatio(volumes, recentDays = 5, windowDays = 20) {
    const need = recentDays + windowDays;
    if (volumes.length < need)
        return 0;
    const recent = volumes.slice(-recentDays);
    const prior = volumes.slice(-need, -recentDays);
    const recentAvg = recent.reduce((s, v) => s + v, 0) / recentDays;
    const priorAvg = prior.reduce((s, v) => s + v, 0) / windowDays;
    if (priorAvg <= 0)
        return 0; // 防除零
    return recentAvg / priorAvg;
}
/** 从 kline.py 输出解析 K 线摘要。容忍字段缺失。 */
function parseKline(raw) {
    const closes = extractCloses(raw);
    if (closes.length < 2)
        return { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0, volume_ratio_5_20: 0 };
    const volumes = extractVolumes(raw);
    const last = closes[closes.length - 1];
    const ago5 = closes.length > 5 ? closes[closes.length - 6] : closes[0];
    const ago20 = closes.length > 20 ? closes[closes.length - 21] : closes[0];
    const recent = closes.slice(-5);
    return {
        pct_5d: ago5 > 0 ? (last - ago5) / ago5 * 100 : 0,
        pct_20d: ago20 > 0 ? (last - ago20) / ago20 * 100 : 0,
        support: Math.min(...recent),
        resistance: Math.max(...recent),
        volatility_20d: computeVolatility(closes, 20),
        volume_ratio_5_20: computeVolumeRatio(volumes, 5, 20),
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
        // industry 来自 fundamentals.py 的 stock_info.industry（东方财富 f127 / datacenter BOARD_NAME 双路拉取）
        industry: typeof raw?.stock_info?.industry === "string" && raw.stock_info.industry.trim() ? raw.stock_info.industry.trim() : "",
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
    // klineR 是 {data, vpa}（safeCall 改造后）；其余只有 data
    const klineRaw = klineR?.data ?? null;
    const vpaText = klineR?.vpa;
    const kline = klineRaw ? parseKline(klineRaw) : { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0, volume_ratio_5_20: 0 };
    const news = newsR?.data ? parseNews(newsR.data) : [];
    const hot = hotR?.data ? parseHotMoney(hotR.data) : { net_5d: 0 };
    const fund = fundR?.data ? parseFundamentals(fundR.data) : { pe: 0, pb: 0, rev_q1: 0, np_q1: 0, industry: "" };
    return {
        ticker, name, sector,
        kline, news,
        hot_money: hot,
        fundamentals: fund,
        ranker_thesis: rankerThesis,
        vpa_text: vpaText, // kline.py 预计算的 VPA 量价背离结论，undefined 则不注入
    };
}
/** 安全调用 execSkillScript，失败返回 null。
 *  返回 {data, vpa?} —— data 是脚本主输出，vpa 是 kline.py 额外的量价预计算文本
 *  （exec-python.ts:280 提到顶层）。非 kline 脚本无 vpa，该字段 undefined。 */
async function safeCall(fn) {
    try {
        const result = await fn();
        if (!result || !result.success)
            return null;
        return {
            data: result.data,
            vpa: typeof result.vpa === "string" ? result.vpa : undefined,
        };
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