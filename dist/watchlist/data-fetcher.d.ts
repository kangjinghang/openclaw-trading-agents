import type { StockData } from "./shallow-analyzer";
/** 从 kline.py 输出解析 K 线摘要。容忍字段缺失。 */
export declare function parseKline(raw: any): {
    pct_5d: number;
    pct_20d: number;
    support: number;
    resistance: number;
};
export declare function parseNews(raw: any): string[];
export declare function parseHotMoney(raw: any): {
    net_5d: number;
};
export declare function parseFundamentals(raw: any): {
    pe: number;
    pb: number;
    rev_q1: number;
    np_q1: number;
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