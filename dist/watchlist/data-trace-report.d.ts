import type { StockData } from "./shallow-analyzer";
import type { StockReport, Action } from "./rebalance-types";
/** 单只股票条目（用于 generateDataTraceReport 多股版）。 */
export interface TraceStockEntry {
    ticker: string;
    name: string;
    stockData: StockData;
    stockReport?: StockReport;
    action?: Action;
    positionTrace?: string;
}
/** 生成包含所有股票的 data-trace.html。
 * 顶部股票切换器（tab）切换显示某只股票的数据管道；导航锚点随当前股票重定向。
 * 多股 sections 各自独立 id（stock-{ticker}-calls 等），靠 CSS .stock-panel
 * 显示/隐藏切换——不删除 DOM，切换无重渲染开销。
 * 单股时退化为原行为（一个 tab，无切换感）。 */
export declare function generateDataTraceReport(...entries: TraceStockEntry[]): string;
//# sourceMappingURL=data-trace-report.d.ts.map