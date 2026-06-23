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
exports.EMPTY_HOT_MONEY = void 0;
exports.computeVolumeRatio = computeVolumeRatio;
exports.parseKline = parseKline;
exports.parseNews = parseNews;
exports.parseNewsLayerStats = parseNewsLayerStats;
exports.parseHotMoney = parseHotMoney;
exports.parseFundamentals = parseFundamentals;
exports.parseLockup = parseLockup;
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
/** news.py 单条 article 的 content 原始截断 300 字（skills/trading-news/scripts/news.py:57），
 *  shallow 是 5 条 × N 字，控制 prompt 总量：每条 content 截 120 字（≈60 汉字，够判标题党）。 */
const NEWS_CONTENT_MAX_CHARS = 120;
function parseNews(raw) {
    // news.py 输出字段是 stock_news（skills/trading-news/scripts/news.py:220）。
    // 老实现读 raw.news → 字段名不匹配，恒返回 []。修正为 stock_news，兼容老格式 raw.news。
    const list = Array.isArray(raw?.stock_news) ? raw.stock_news : (Array.isArray(raw?.news) ? raw.news : []);
    return list.slice(0, 5).map((n) => {
        if (!n || typeof n !== "object")
            return null;
        const title = typeof n.title === "string" ? n.title.trim() : "";
        if (!title)
            return null;
        const item = { title };
        if (typeof n.content === "string" && n.content.trim()) {
            item.content = n.content.slice(0, NEWS_CONTENT_MAX_CHARS);
        }
        if (typeof n.time === "string" && n.time.trim())
            item.time = n.time.trim();
        if (typeof n.source === "string" && n.source.trim())
            item.source = n.source.trim();
        return item;
    }).filter((x) => x !== null);
}
/** 从 news.py 输出解析时间分层数量统计（layer_stats）。
 *  shallow 用它判断热门/冷门 + 突发：6h 突发提权重，total 低=冷门。
 *  字段缺失或非数字 → 返回 null（undefined 语义），不阻塞分析。 */
function parseNewsLayerStats(raw) {
    const s = raw?.layer_stats;
    if (!s || typeof s !== "object")
        return null;
    const num = (v) => typeof v === "number" && !isNaN(v) ? v : 0;
    const stats = {
        realtime_6h_count: num(s.realtime_6h_count),
        extended_24h_count: num(s.extended_24h_count),
        history_7d_count: num(s.history_7d_count),
        total_categorized: num(s.total_categorized),
    };
    // 全 0 视为无效（拉取失败或空数据），返回 null 避免误导 LLM
    if (stats.total_categorized === 0 && stats.realtime_6h_count === 0
        && stats.extended_24h_count === 0 && stats.history_7d_count === 0) {
        return null;
    }
    return stats;
}
/** 全空 HotMoneyData 兜底（拉取失败/字段全缺时用）。 */
exports.EMPTY_HOT_MONEY = {
    main_net_today: 0,
    super_net_today: 0,
    large_net_today: 0,
    northbound_yi: 0,
    northbound_signal: "",
    sector_in_industry_tag: "",
};
/** 从 hot_money.py 输出解析资金面摘要（5 个子源预压缩为浅层字段 + 文本片段）。
 *
 *  ⚠️ 修复历史 bug：老实现 `return { net_5d: raw?.net_5d }`，但 hot_money.py 顶层
 *  无 net_5d 字段（真实结构是 fund_flow.main_net / northbound / ...），导致恒返回 0。
 *  且 fund_flow.main_net 是「当日」主力净流入（_fetch_fund_flow 只取 klines[-1]），
 *  非 5 日累计——此处诚实命名为 main_net_today，避免误导下游。
 *
 *  raw 结构（exec-python.ts 已把 raw.data 提到顶层）：
 *  { ticker, date, northbound:{total,signal,...}, fund_flow:{main_net,large_net,super_net},
 *    sector_fund_flow:{inflow_top:[{name,main_net_yi,...}], outflow_top:[...], total_boards},
 *    hot_stocks:[{code,name,reason,change_pct}], dragon_tiger:[{date,net_buy,turnover,...}] }
 *
 *  industry 参数用于判断标的行业是否落在当日板块流入/流出榜（板块轮动信号），
 *  来自已 parse 的 fundamentals.industry，可为空（拉取失败时）。
 *  全程容忍字段缺失，不抛异常。 */
function parseHotMoney(raw, industry) {
    if (!raw || typeof raw !== "object")
        return { ...exports.EMPTY_HOT_MONEY };
    const num = (v) => typeof v === "number" && !isNaN(v) ? v : 0;
    const ff = raw.fund_flow || {};
    const nb = raw.northbound;
    // 龙虎榜：取最近 2 条（脚本已按日期倒序），压成 "MM-DD 净买±X亿 换手Y%"
    // 另取最近一条的 reason（上榜原因：日涨幅偏离/换手达标等）——判断游资炒作 vs 业绩驱动
    let dragonTigerRecent;
    let dragonTigerReason;
    const dt = Array.isArray(raw.dragon_tiger) ? raw.dragon_tiger : [];
    if (dt.length > 0) {
        const lines = dt.slice(0, 2).map((r) => {
            const d = typeof r?.date === "string" ? r.date.slice(5) : "?"; // MM-DD
            const net = num(r?.net_buy);
            const sign = net > 0 ? "+" : "";
            const turn = num(r?.turnover);
            return `${d} 净买${sign}${net.toFixed(1)}亿 换手${turn.toFixed(1)}%`;
        });
        dragonTigerRecent = `${dt.length}次(最近${lines.join("；")})`;
        const reason0 = typeof dt[0]?.reason === "string" ? dt[0].reason.trim() : "";
        if (reason0)
            dragonTigerReason = reason0.slice(0, 20);
    }
    // 板块轮动：inflow_top/outflow_top 取前 3 行业名，并判标的行业归属
    let sectorInflowTop;
    let sectorOutflowTop;
    let sectorTag = "";
    const sff = raw.sector_fund_flow;
    if (sff && typeof sff === "object") {
        const inflow = Array.isArray(sff.inflow_top) ? sff.inflow_top : [];
        const outflow = Array.isArray(sff.outflow_top) ? sff.outflow_top : [];
        if (inflow.length > 0) {
            sectorInflowTop = inflow.slice(0, 3)
                .map((b) => typeof b?.name === "string" ? b.name : "")
                .filter(Boolean)
                .join("/");
        }
        if (outflow.length > 0) {
            sectorOutflowTop = outflow.slice(0, 3)
                .map((b) => typeof b?.name === "string" ? b.name : "")
                .filter(Boolean)
                .join("/");
        }
        // 行业归属判断：industry 非空时才比对（拉取失败则留空，renderHotMoneySummary 会省略）
        if (industry) {
            const inHit = inflow.some((b) => typeof b?.name === "string" && b.name.includes(industry));
            const outHit = outflow.some((b) => typeof b?.name === "string" && b.name.includes(industry));
            sectorTag = inHit ? "主线" : outHit ? "弱势" : "未上榜";
        }
    }
    // 今日热门股：取前 3 条 name(reason)
    let hotStocksTop;
    const hs = Array.isArray(raw.hot_stocks) ? raw.hot_stocks : [];
    if (hs.length > 0) {
        hotStocksTop = hs.slice(0, 3).map((r) => {
            const name = typeof r?.name === "string" ? r.name : "";
            const reason = typeof r?.reason === "string" && r.reason.trim() ? `(${r.reason.trim().slice(0, 8)})` : "";
            return `${name}${reason}`;
        }).filter(Boolean).join("/");
    }
    return {
        main_net_today: num(ff.main_net),
        super_net_today: num(ff.super_net),
        large_net_today: num(ff.large_net),
        northbound_yi: num(nb?.total),
        northbound_signal: nb?.signal === "inflow" || nb?.signal === "outflow" ? nb.signal : "",
        dragon_tiger_recent: dragonTigerRecent,
        dragon_tiger_reason: dragonTigerReason,
        sector_inflow_top: sectorInflowTop,
        sector_outflow_top: sectorOutflowTop,
        sector_in_industry_tag: sectorTag,
        hot_stocks_top: hotStocksTop,
    };
}
function parseFundamentals(raw) {
    // fundamentals.py 的真实输出是嵌套结构：
    //   valuation.pe_ttm / valuation.pb          （腾讯实时估值）
    //   financial_snapshot.revenue / .net_profit （mootdx 财务快照）
    //   stock_info.industry                       （东方财富 f127 / datacenter BOARD_NAME 双路）
    //   quarterly_trends / consensus_eps          （datacenter 季度趋势 / 机构预期）
    // 老实现误读顶层 pe_ttm/pb/revenue_q1/net_profit_q1 → 恒 0，导致 shallow-analyzer
    // 的 PE/PB/营收/净利全盲，fitness 被评分规则压制到 ≤6（无法证实业绩）。
    // 主路读嵌套字段；保留顶层/别名作为容错（兼容可能的旧扁平格式或其他调用方）。
    const val = raw?.valuation ?? {};
    const snap = raw?.financial_snapshot ?? {};
    const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
    return {
        pe: num(val.pe_ttm) || num(val.pe) || num(raw?.pe_ttm) || num(raw?.pe),
        pb: num(val.pb) || num(raw?.pb),
        // 字段名对齐 fundamentals.py：snapshot 用 revenue/net_profit（无 _q1 后缀）
        rev_q1: num(snap.revenue) || num(snap.revenue_q1) || num(raw?.revenue_q1) || num(raw?.rev_q1),
        np_q1: num(snap.net_profit) || num(snap.net_profit_q1) || num(raw?.net_profit_q1) || num(raw?.np_q1),
        industry: typeof raw?.stock_info?.industry === "string" && raw.stock_info.industry.trim() ? raw.stock_info.industry.trim() : "",
        // quarterly_trends / consensus_eps 原样透传（压缩逻辑放 render 函数，保持解析层薄）。
        // 防御 fundamentals.py 异常输出：非数组/非对象 → undefined，render 据此省略整行。
        quarterly_trends: Array.isArray(raw?.quarterly_trends) ? raw.quarterly_trends : undefined,
        consensus_eps: raw?.consensus_eps && typeof raw.consensus_eps === "object" && !Array.isArray(raw.consensus_eps)
            ? raw.consensus_eps : undefined,
    };
}
/** 从 lockup.py 输出解析解禁与减持摘要。
 *
 *  raw 结构（exec-python.ts 已把 raw.data 提到顶层）：
 *  { lockup_upcoming:[{date,type,shares,ratio}], reduce_holdings:[{date,reducing_shareholder,...}],
 *    pressure_rating:"重大压力"|... }
 *  shares/ratio 在脚本侧是字符串，原样透传（不强转，避免 parse 失败丢信息，LLM 直接读字符串）。
 *  全程容忍字段缺失。pressure_rating 缺失 → "未知"。upcoming/reduce_holdings 全空且无评级 → null（无数据）。 */
function parseLockup(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const rating = typeof raw.pressure_rating === "string" && raw.pressure_rating.trim()
        ? raw.pressure_rating.trim() : "未知";
    const upcoming = Array.isArray(raw.lockup_upcoming)
        ? raw.lockup_upcoming
            .filter((x) => !!x && typeof x === "object" && typeof x.date === "string")
            .map((x) => ({
            date: x.date,
            ...(typeof x.type === "string" && x.type ? { type: x.type } : {}),
            ...(typeof x.shares === "string" && x.shares ? { shares: x.shares } : {}),
            ...(typeof x.ratio === "string" && x.ratio ? { ratio: x.ratio } : {}),
        }))
        : [];
    const reduceHoldings = Array.isArray(raw.reduce_holdings)
        ? raw.reduce_holdings
            .filter((x) => !!x && typeof x === "object" && typeof x.date === "string")
            .map((x) => ({
            date: x.date,
            ...(typeof x.reducing_shareholder === "string" && x.reducing_shareholder ? { reducing_shareholder: x.reducing_shareholder } : {}),
            ...(typeof x.reducing_shares === "string" && x.reducing_shares ? { reducing_shares: x.reducing_shares } : {}),
            ...(typeof x.reducing_ratio === "string" && x.reducing_ratio ? { reducing_ratio: x.reducing_ratio } : {}),
            ...(typeof x.reduce_reason === "string" && x.reduce_reason ? { reduce_reason: x.reduce_reason } : {}),
        }))
        : [];
    // 全空（拉取失败或真无数据）：评级非"未知"才保留（让 LLM 知道"无明显压力"），
    // 否则 upcoming/reduce_holdings 全空 + 评级未知 = 没拿到数据，省略整段。
    if (upcoming.length === 0 && reduceHoldings.length === 0 && rating === "未知") {
        return null;
    }
    return { pressure_rating: rating, upcoming, reduce_holdings: reduceHoldings };
}
/** 单股并行跑 5 个 script（kline/news/hot_money/fundamentals/lockup）。失败的 script 返回 null 字段（容忍）。 */
async function fetchStockData(ticker, name, sector, rankerThesis) {
    // news.py 的 --ticker/--date 是 required（skills/trading-news/scripts/news.py:262-263），
    // 老实现只传 [ticker] 位置参数 → argparse 报错 → news 恒为 []。
    // 用 today 作为分析日期；--lookback-days 7 对齐 trading_full 的 news 角色。
    // --skip-macro：shallow 不消费宏观新闻（与 ticker 无关、N 股重复拉取纯浪费），
    // 省掉 CLS+akshare 两路 HTTP（实测单股 1.27s→0.37s，-71%）。
    const today = new Date().toISOString().slice(0, 10);
    const tasks = [
        safeCall(() => (0, exec_python_1.execSkillScript)("trading-kline", "kline", PROJECT_ROOT, [ticker])),
        safeCall(() => (0, exec_python_1.execSkillScript)("trading-news", "news", PROJECT_ROOT, ["--ticker", ticker, "--date", today, "--lookback-days", "7", "--skip-macro"])),
        safeCall(() => (0, exec_python_1.execSkillScript)("trading-hot-money", "hot_money", PROJECT_ROOT, [ticker])),
        safeCall(() => (0, exec_python_1.execSkillScript)("trading-fundamentals", "fundamentals", PROJECT_ROOT, [ticker])),
        // lockup.py：--ticker/--date 均 required，解禁区间 [date, date+90]。全量接入（含 mootdx F10），
        // 慢（5-8s，F10 是瓶颈），但未来 90 天解禁是 rebalancer 中期组合的硬风险。
        safeCall(() => (0, exec_python_1.execSkillScript)("trading-lockup", "lockup", PROJECT_ROOT, ["--ticker", ticker, "--date", today])),
    ];
    const [klineR, newsR, hotR, fundR, lockupR] = await Promise.all(tasks);
    // klineR 是 {data, vpa}（safeCall 改造后）；其余只有 data
    const klineRaw = klineR?.data ?? null;
    const vpaText = klineR?.vpa;
    const kline = klineRaw ? parseKline(klineRaw) : { pct_5d: 0, pct_20d: 0, support: 0, resistance: 0, volatility_20d: 0, volume_ratio_5_20: 0 };
    const news = newsR?.data ? parseNews(newsR.data) : [];
    const newsLayerStats = newsR?.data ? parseNewsLayerStats(newsR.data) ?? undefined : undefined;
    const fund = fundR?.data ? parseFundamentals(fundR.data) : { pe: 0, pb: 0, rev_q1: 0, np_q1: 0, industry: "", quarterly_trends: undefined, consensus_eps: undefined };
    // fund 先于 hot 解析：parseHotMoney 需要 industry 判板块轮动归属（主线/弱势/未上榜）
    const hot = hotR?.data ? parseHotMoney(hotR.data, fund.industry) : { ...exports.EMPTY_HOT_MONEY };
    const lockup = lockupR?.data ? parseLockup(lockupR.data) ?? undefined : undefined;
    return {
        ticker, name, sector,
        kline, news,
        hot_money: hot,
        fundamentals: fund,
        ranker_thesis: rankerThesis,
        vpa_text: vpaText, // kline.py 预计算的 VPA 量价背离结论，undefined 则不注入
        news_layer_stats: newsLayerStats, // news.py layer_stats，undefined 则不注入
        lockup, // lockup.py 解禁+减持，undefined（拉取失败/无数据）则 risk prompt 省略解禁段
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