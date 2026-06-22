import type { StockData, NewsItem, NewsLayerStats, HotMoneyData } from "./shallow-analyzer";
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
};
/** 单股并行跑 4 个 script。失败的 script 返回 null 字段（容忍）。 */
export declare function fetchStockData(ticker: string, name: string, sector: string, rankerThesis?: string): Promise<StockData | null>;
/** 跨股并行 fetch（concurrency=5）。失败的股跳过。 */
export declare function fetchAllStockData(metas: Array<{
    ticker: string;
    name: string;
    sector: string;
    ranker_thesis?: string;
}>, concurrency?: number): Promise<Map<string, StockData>>;
//# sourceMappingURL=data-fetcher.d.ts.map