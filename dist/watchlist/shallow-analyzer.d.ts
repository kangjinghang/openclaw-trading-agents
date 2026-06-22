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
        volatility_20d: number;
        volume_ratio_5_20: number;
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
        industry: string;
    };
    ranker_thesis?: string;
    /** kline.py 预计算的 VPA 量价分析文本（含"顶部背离信号/放量滞涨"等结论）。
     *  undefined = 无 VPA 数据（非 kline 脚本或拉取失败）。 */
    vpa_text?: string;
}
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