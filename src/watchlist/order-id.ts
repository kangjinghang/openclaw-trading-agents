// src/watchlist/order-id.ts
//
// order_id 幂等键：让云服务器能识别"这份订单执行过了，跳过"。
// 算法：date + "-" + sha256(canonicalize(actions)).slice(0,6)
// 规范化（按 ticker 排序 + weight 四舍五入到 4 位）保证：
//   - Mac 重跑 rebalancer 若 actions 内容不变 → id 不变 → 跳过
//   - actions 顺序乱 → id 不变（规范化生效）
//   - 改任一 weight（超 4 位精度）→ id 变 → 视为新订单

import * as crypto from "crypto";
import type { LastRebalanceAction } from "./rebalance-types";

/** 规范化 actions 到稳定字符串：按 ticker 排序，weight 四舍五入到 4 位。 */
export function canonicalizeActions(actions: LastRebalanceAction[]): string {
  // 用字节比较而非 localeCompare：order_id 可能跨多台开发机计算，需保证
  // 排序结果与 Node ICU 数据无关（不同机器/Node 构建可能 locale 行为不同）。
  // ticker 都是 ASCII，简单 < / > 比较即可确定且无歧义。
  const sorted = [...actions].sort((a, b) =>
    a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0);
  return JSON.stringify(sorted.map(a => ({
    action: a.action,
    ticker: a.ticker,
    weight: Number(a.weight.toFixed(4)),
  })));
}

/** 计算幂等 order_id："YYYY-MM-DD-<6位hex>"。 */
export function computeOrderId(date: string, actions: LastRebalanceAction[]): string {
  const hash = crypto.createHash("sha256").update(canonicalizeActions(actions)).digest("hex");
  return `${date}-${hash.slice(0, 6)}`;
}
