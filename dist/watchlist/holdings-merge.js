"use strict";
// src/watchlist/holdings-merge.ts
//
// 持仓字段级合并契约（TS 权威实现）。云服务器执行订单后调此函数把 QMT
// 真实持仓合并进 holdings.json：
//   - 市场字段（shares/entry_price/entry_date/weight/cash_pct）以 QMT 为准
//   - 本地字段（sector/name）保留（QMT 查不到）
//   - QMT volume=0 的清仓股删除
//   - QMT 新出现的持仓新增（sector 标"未分类"）
// Python 端 merge.py 有等价实现（跨语言一致性测试固定 fixture）。
// 此函数也在 TS 端用于文档化契约 + 测试验证合并规则。
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeHoldings = mergeHoldings;
/** 字段级合并：QMT 市场字段覆盖，本地字段保留，清仓删除，新仓新增。 */
function mergeHoldings(remote, qmtPositions, qmtAsset) {
    const remoteByTicker = new Map();
    for (const p of remote.positions)
        remoteByTicker.set(p.ticker, p);
    const mergedPositions = [];
    for (const qp of qmtPositions) {
        if (qp.volume === 0)
            continue; // 清仓删除
        const existing = remoteByTicker.get(qp.ticker);
        mergedPositions.push({
            ticker: qp.ticker,
            // name/sector 保留本地（QMT 不提供）；新仓 name 留空待补
            name: existing?.name ?? "",
            sector: existing?.sector ?? "未分类",
            shares: qp.volume,
            entry_price: qp.open_price,
            entry_date: qp.open_date,
            weight: qmtAsset.total > 0 ? qp.market_value / qmtAsset.total : 0,
        });
    }
    return {
        updated_at: new Date().toISOString(),
        cash_pct: qmtAsset.total > 0 ? qmtAsset.cash / qmtAsset.total : 0,
        positions: mergedPositions,
    };
}
//# sourceMappingURL=holdings-merge.js.map