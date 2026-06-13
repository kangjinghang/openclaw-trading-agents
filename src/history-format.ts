// src/history-format.ts — 纯函数：历史报告过滤 + 卡片格式化
// 被 src/index.ts 的 trading_history 工具调用；不依赖 OpenAI / 磁盘 IO。

import { ReportSummary } from "./dashboard-api";

/** 查询参数（与 trading_history 工具入参一致）。 */
export interface HistoryQuery {
  ticker?: string;
  direction?: string;
  mode?: string;
  date_from?: string;
  date_to?: string;
}

/**
 * 把中英文方向名规范化为 canonical "Buy"/"Sell"/"Hold"。
 * 未识别 / 空 / undefined 返回 null（供过滤逻辑区分"未提供"与"不匹配"）。
 * 注意：不能用 orchestrator.parseDirection（它把未知默认为 Hold，会污染过滤）。
 */
export function normalizeDirection(raw?: string): "Buy" | "Sell" | "Hold" | null {
  if (!raw) return null;
  const n = raw.trim().toLowerCase();
  if (!n) return null;
  if (["buy", "overweight", "看多", "多", "买入", "增持"].includes(n)) return "Buy";
  if (["sell", "underweight", "看空", "空", "卖出", "减持"].includes(n)) return "Sell";
  if (["hold", "neutral", "中性", "观望", "持有"].includes(n)) return "Hold";
  return null;
}

/**
 * 多维 AND 过滤。所有维度可选；未提供的维度不过滤。
 * 方向维度：用户提供了 direction 但无法识别 → 返回空（视为"不匹配任何"）。
 */
export function filterReports(reports: ReportSummary[], q: HistoryQuery): ReportSummary[] {
  const dirProvided = q.direction !== undefined && q.direction !== "";
  const wantDir = normalizeDirection(q.direction);
  return reports.filter((r) => {
    if (q.ticker && r.ticker !== q.ticker) return false;
    if (q.mode && r.mode !== q.mode) return false;
    if (q.date_from && r.date < q.date_from) return false;
    if (q.date_to && r.date > q.date_to) return false;
    if (dirProvided) {
      if (wantDir === null) return false; // 非法方向 → 不匹配任何
      if (normalizeDirection(r.direction) !== wantDir) return false;
    }
    return true;
  });
}