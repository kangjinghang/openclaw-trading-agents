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

import type { Holdings, Position } from "./rebalance-types";

/** QMT 持仓查询结果的 TS 侧表示（Python query_stock_positions 映射而来）。 */
export interface QmtPosition {
  ticker: string;             // "SZ300319" 格式（Python 端先转好）
  volume: number;             // 总持仓
  open_price: number;         // 成本价
  open_date: string;          // "YYYY-MM-DD"
  market_value: number;
  can_use_volume: number;     // T+1 可卖
}

/** QMT 资产查询结果。 */
export interface QmtAsset {
  total: number;              // 总资产（元）
  cash: number;               // 现金（元）
}

/** 字段级合并：QMT 市场字段覆盖，本地字段保留，清仓删除，新仓新增。 */
export function mergeHoldings(
  remote: Holdings,
  qmtPositions: QmtPosition[],
  qmtAsset: QmtAsset,
): Holdings {
  const remoteByTicker = new Map<string, Position>();
  for (const p of remote.positions) remoteByTicker.set(p.ticker, p);

  const mergedPositions: Position[] = [];
  // 注意：遍历以 QMT 持仓为准，remote 中有但 QMT 未返回的 ticker 不进结果
  // —— 即 absent ≡ 清仓删除（与 volume=0 同语义）。已与用户确认：xtquant
  // query_stock_positions 视为权威持仓快照，不返回即代表该账户已无此持仓。
  for (const qp of qmtPositions) {
    if (qp.volume === 0) continue;  // 清仓删除
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
