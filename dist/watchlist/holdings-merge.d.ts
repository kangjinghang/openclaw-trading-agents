import type { Holdings } from "./rebalance-types";
/** QMT 持仓查询结果的 TS 侧表示（Python query_stock_positions 映射而来）。 */
export interface QmtPosition {
    ticker: string;
    volume: number;
    open_price: number;
    open_date: string;
    market_value: number;
    can_use_volume: number;
}
/** QMT 资产查询结果。 */
export interface QmtAsset {
    total: number;
    cash: number;
}
/** 字段级合并：QMT 市场字段覆盖，本地字段保留，清仓删除，新仓新增。 */
export declare function mergeHoldings(remote: Holdings, qmtPositions: QmtPosition[], qmtAsset: QmtAsset): Holdings;
//# sourceMappingURL=holdings-merge.d.ts.map