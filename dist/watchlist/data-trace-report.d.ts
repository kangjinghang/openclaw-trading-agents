import type { StockData } from "./shallow-analyzer";
import type { StockReport, Action } from "./rebalance-types";
/** 生成单股数据管道调试视图（markdown）。 */
export declare function generateDataTraceReport(ticker: string, name: string, stockData: StockData, stockReport?: StockReport, action?: Action, positionTrace?: string): string;
//# sourceMappingURL=data-trace-report.d.ts.map