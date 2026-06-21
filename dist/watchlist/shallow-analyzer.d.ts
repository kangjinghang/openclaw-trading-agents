import type { AnalystReport, RiskReport, StockReport } from "./rebalance-types";
import type { CandidateMeta } from "./candidate-selector";
export type ShallowLlmCaller = (input: {
    role: "analyst" | "risk";
    data: StockData;
    analyst?: AnalystReport;
}) => Promise<string>;
export interface StockData {
    ticker: string;
    name: string;
    sector: string;
    kline: {
        pct_5d: number;
        pct_20d: number;
        support: number;
        resistance: number;
    };
    news: string[];
    hot_money: {
        net_5d: number;
    };
    fundamentals: {
        pe: number;
        pb: number;
        rev_q1: number;
        np_q1: number;
    };
    ranker_thesis?: string;
}
export declare function formatAnalystPrompt(d: StockData): string;
/** 解析 analyst-role 输出。非 JSON / 缺字段返回 null（或填默认值）。 */
export declare function parseAnalystReport(content: string): AnalystReport | null;
export declare function formatRiskPrompt(d: StockData, analyst: AnalystReport): string;
export declare function parseRiskReport(content: string): RiskReport | null;
/** 合并 candidate meta + analyst report + risk report → 完整 StockReport。 */
export declare function buildStockReport(meta: CandidateMeta, sector: string, analyst: AnalystReport, risk: RiskReport): StockReport;
/** 对所有候选/持仓股并行跑 analyst + risk 双 call。
 *  单股失败（LLM 异常或数据缺失）跳过，rebalancer 看不到该股。 */
export declare function analyzeAll(metas: CandidateMeta[], dataByTicker: Map<string, StockData>, caller: ShallowLlmCaller): Promise<StockReport[]>;
//# sourceMappingURL=shallow-analyzer.d.ts.map