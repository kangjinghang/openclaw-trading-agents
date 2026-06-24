import type { StockData, NewsItem, NewsLayerStats, HotMoneyData, QuarterlyTrend, ConsensusEps, LockupData } from "./shallow-analyzer";
/** 量比：近 recentDays 日均量 / 前 windowDays 日均量。
 *  典型用法：computeVolumeRatio(volumes, 5) = 近5日均量 / 20日均量。
 *  - ratio < 0.8 → 缩量（趋势可能衰竭，量价背离风险）
 *  - ratio > 1.2 → 放量（资金关注）
 *  数据不足（< recentDays + windowDays）或除零 → 0（容忍）。 */
export declare function computeVolumeRatio(volumes: number[], recentDays?: number, windowDays?: number): number;
export interface KlineSummary {
    pct_5d: number;
    pct_20d: number;
    support: number;
    resistance: number;
    volatility_20d: number;
    /** 近5日均量 / 20日均量。<0.8 缩量，>1.2 放量。无 volume 数据 → 0 */
    volume_ratio_5_20: number;
}
/** 从 kline.py 输出解析 K 线摘要。容忍字段缺失。 */
export declare function parseKline(raw: any): KlineSummary;
export declare function parseNews(raw: any): NewsItem[];
/** 从 news.py 输出解析时间分层数量统计（layer_stats）。
 *  shallow 用它判断热门/冷门 + 突发：6h 突发提权重，total 低=冷门。
 *  字段缺失或非数字 → 返回 null（undefined 语义），不阻塞分析。 */
export declare function parseNewsLayerStats(raw: any): NewsLayerStats | null;
/** 全空 HotMoneyData 兜底（拉取失败/字段全缺时用）。 */
export declare const EMPTY_HOT_MONEY: HotMoneyData;
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
export declare function parseHotMoney(raw: any, industry?: string): HotMoneyData;
export declare function parseFundamentals(raw: any): {
    pe: number;
    pb: number;
    rev_q1: number;
    np_q1: number;
    industry: string;
    quarterly_trends?: QuarterlyTrend[];
    consensus_eps?: ConsensusEps;
    pe_percentile?: number;
    pb_percentile?: number;
};
/** 从 lockup.py 输出解析解禁与减持摘要。
 *
 *  raw 结构（exec-python.ts 已把 raw.data 提到顶层）：
 *  { lockup_upcoming:[{date,type,shares,ratio}], reduce_holdings:[{date,reducing_shareholder,...}],
 *    pressure_rating:"重大压力"|... }
 *  shares/ratio 在脚本侧是字符串，原样透传（不强转，避免 parse 失败丢信息，LLM 直接读字符串）。
 *  全程容忍字段缺失。pressure_rating 缺失 → "未知"。upcoming/reduce_holdings 全空且无评级 → null（无数据）。 */
export declare function parseLockup(raw: any): LockupData | null;
/** 全市场宏观视图（来自 news.py --macro-only，一次性抓取）。
 *
 *  宏观与具体股票无关（财新PMI/大宗/NBS/LPR 都是全市场信号），故 rebalancer 每次跑
 *  只抓 1 次注入组合决策层，而非每股抓 1 次（data-fetcher 每股 news.py 仍 --skip-macro）。
 *  字段全部可选——拉取失败或部分指标不可用时 graceful degrade（对应字段 undefined，
 *  renderMacroSection 据此省略分句）。
 *
 *  - market_view：news.py _build_macro_sector_view 推导的总体倾向
 *    （"震荡偏多"|"震荡偏谨慎"|"结构性机会为主"）
 *  - pmi_signal：官方与财新 PMI 双口径共振/背离结论
 *  - bullish_sectors / bearish_sectors：规则引擎推导的景气/承压板块名
 *  - sector_scores：板块 → 宏观得分（正=景气，负=承压）
 *  - commodities：金/油/铜主力连续（新浪期货），含 5/20 日涨跌幅 + 趋势标签
 *  - indicators_used：本次实际取到的宏观指标 key（判断数据完整度） */
export interface MacroView {
    market_view?: string;
    pmi_signal?: string;
    bullish_sectors?: string[];
    bearish_sectors?: string[];
    sector_scores?: Record<string, number>;
    commodities?: Record<string, {
        label: string;
        chg_5d?: number;
        chg_20d?: number;
        trend?: string;
    }>;
    indicators_used?: string[];
}
/** 从 news.py --macro-only 输出解析 MacroView。
 *  容忍字段缺失——sector_view / commodities 任一缺失则对应字段 undefined。
 *  全空（拉取失败）返回 null，让调用方据此省略宏观段。 */
export declare function parseMacroView(raw: any): MacroView | null;
export declare function fetchMacroData(date: string): Promise<MacroView | null>;
/** 单股并行跑 5 个 script（kline/news/hot_money/fundamentals/lockup）。失败的 script 返回 null 字段（容忍）。 */
export declare function fetchStockData(ticker: string, name: string, sector: string, rankerThesis?: string): Promise<StockData | null>;
/** 跨股并行 fetch（concurrency=5）。失败的股跳过。 */
export declare function fetchAllStockData(metas: Array<{
    ticker: string;
    name: string;
    sector: string;
    ranker_thesis?: string;
}>, concurrency?: number): Promise<Map<string, StockData>>;
//# sourceMappingURL=data-fetcher.d.ts.map