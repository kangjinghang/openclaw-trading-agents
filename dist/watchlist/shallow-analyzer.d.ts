import type { AnalystReport, RiskReport, StockReport } from "./rebalance-types";
import type { CandidateMeta } from "./candidate-selector";
export type ShallowLlmCaller = (input: {
    role: "analyst" | "risk";
    data: StockData;
    analyst?: AnalystReport;
}) => Promise<string>;
/** 单条新闻。title 必有；content/time/source 可缺（数据源差异或拉取失败）。 */
export interface NewsItem {
    title: string;
    content?: string;
    time?: string;
    source?: string;
}
/** 新闻时间分层数量统计（news.py 的 layer_stats）。
 *  反映个股的市场关注密度 + 突发性，是 shallow 判断"热门/冷门"和"有无突发"的关键信号。
 *  - realtime_6h_count：最近 6 小时新闻数（>0 = 有突发，提权重）
 *  - total_categorized：7 天总条数（低 = 冷门股，流动性风险）
 *  全部 0 或 undefined = 无统计（拉取失败或字段缺失），不阻塞分析。 */
export interface NewsLayerStats {
    realtime_6h_count: number;
    extended_24h_count: number;
    history_7d_count: number;
    total_categorized: number;
}
/** 资金面摘要（来自 hot_money.py 的 5 个子源，parseHotMoney 预压缩为浅层字段 + 文本片段）。
 *
 *  ⚠️ 字段命名诚实：main_net_today 是「当日」主力净流入，不是 5 日累计——
 *  hot_money.py 的 _fetch_fund_flow 只解析最后一根日 K（klt=1, klines[-1]），
 *  没有 5 日聚合逻辑。老实现字段叫 net_5d 但实际取不到值（顶层无此字段，恒 0），
 *  此处修正为 main_net_today 与脚本语义对齐，避免误导 LLM 把当日数字当成 5 日趋势。
 *
 *  - 标量字段（main_net_today / *_net_today / northbound_*）：缺失或拉取失败 → 0/空串
 *  - 文本片段（dragon_tiger_recent / sector_inflow_top / sector_outflow_top / hot_stocks_top）：
 *    缺数据 → undefined，renderHotMoneySummary 据此省略对应分句
 *  - sector_in_industry_tag：标的行业是否落在当日板块流入/流出榜，"主线"|"弱势"|"未上榜"|""
 *  - dragon_tiger_reason：最近一次上榜原因（日涨幅偏离/换手达标等），判断游资炒作 vs 业绩驱动 */
export interface HotMoneyData {
    main_net_today: number;
    super_net_today: number;
    large_net_today: number;
    northbound_yi: number;
    northbound_signal: string;
    dragon_tiger_recent?: string;
    dragon_tiger_reason?: string;
    sector_inflow_top?: string;
    sector_outflow_top?: string;
    sector_in_industry_tag: string;
    hot_stocks_top?: string;
}
export interface StockData {
    ticker: string;
    name: string;
    sector: string;
    kline: {
        pct_5d: number;
        pct_20d: number;
        support: number;
        resistance: number;
        volatility_20d: number;
        volume_ratio_5_20: number;
    };
    /** 个股新闻（最多 5 条，含标题/正文摘要/时间）。
     *  旧实现是 string[]（只有标题），现升级为 NewsItem[] 让 LLM 判断时效性 + 标题党。 */
    news: NewsItem[];
    hot_money: HotMoneyData;
    fundamentals: {
        pe: number;
        pb: number;
        rev_q1: number;
        np_q1: number;
        industry: string;
    };
    ranker_thesis?: string;
    /** kline.py 预计算的 VPA 量价分析文本（含"顶部背离信号/放量滞涨"等结论）。
     *  undefined = 无 VPA 数据（非 kline 脚本或拉取失败）。 */
    vpa_text?: string;
    /** 新闻时间分层数量（news.py layer_stats）。undefined = 无统计，不阻塞分析。
     *  shallow 用它判断热门/冷门 + 有无突发，是一行文本的成本换密度信号。 */
    news_layer_stats?: NewsLayerStats;
}
export declare function renderHotMoneySummary(h: HotMoneyData): string;
export declare function formatAnalystPrompt(d: StockData): string;
/** 解析 analyst-role 输出。非 JSON / 缺字段返回 null（或填默认值）。 */
export declare function parseAnalystReport(content: string): AnalystReport | null;
export declare function formatRiskPrompt(d: StockData, analyst: AnalystReport): string;
export declare function parseRiskReport(content: string): RiskReport | null;
/** 合并 candidate meta + analyst report + risk report → 完整 StockReport。 */
export declare function buildStockReport(meta: CandidateMeta, sector: string, analyst: AnalystReport, risk: RiskReport): StockReport;
/** 持仓股 shallow-analyzer 失败时的保守默认 report。
 *
 *  为什么持仓股不能像候选股一样"失败就消失"：
 *  - 候选股失败 = 少一个机会（损失小）
 *  - 持仓股失败 = 漏看一个风险（损失大）—— rebalancer 既不 HOLD 也不 REDUCE，
 *    一个用户实际持有的、可能需要止损的股被静默忽略
 *
 *  默认值设计（逼 rebalancer 面对，但不乱下结论）：
 *  - fitness=5：触发"持仓 fitness≤5 必须 REDUCE/SELL"硬规则，rebalancer 必须提它
 *  - risk=high：数据缺失=未知风险，仓位公式会打折
 *  - deal_breaker=false：无证据不清仓（清仓是重大决策）
 *  - locked 保留：anti-churn 卖锁仍生效，不会乱减锁定股 */
export declare function buildFallbackReport(meta: CandidateMeta, sector: string, reason: string): StockReport;
/** 对所有候选/持仓股跑 analyst + risk 双 call（单股内串行，跨股并发限制）。
 *
 *  失败处理（风控关键）：
 *  - 候选股失败 → 跳过（少一个机会，无伤大雅）
 *  - 持仓股失败 → 保守默认 report（fitness=5, risk=high），不消失
 *    否则 rebalancer 看不到它，一个可能需要止损的持仓股被静默忽略
 *
 *  concurrency 默认 3 —— zhipu glm-5.1 free tier 在并发 ≥5 时触发 429。
 *  跨股 worker pool + 单股内 analyst→risk 串行 = 任意时刻最多 concurrency 个 LLM call。 */
export declare function analyzeAll(metas: CandidateMeta[], dataByTicker: Map<string, StockData>, caller: ShallowLlmCaller, concurrency?: number): Promise<StockReport[]>;
//# sourceMappingURL=shallow-analyzer.d.ts.map