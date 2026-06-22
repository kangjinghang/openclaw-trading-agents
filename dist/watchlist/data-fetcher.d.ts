import type { StockData } from "./shallow-analyzer";
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
export declare function parseNews(raw: any): string[];
export declare function parseHotMoney(raw: any): {
    net_5d: number;
};
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