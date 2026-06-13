// src/history-format.ts — 纯函数：历史报告过滤 + 卡片格式化
// 被 src/index.ts 的 trading_history 工具调用；不依赖 OpenAI / 磁盘 IO。

import { ReportSummary } from "./dashboard-api";
import { formatElapsed } from "./orchestrator";

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

function dirEmoji(d: string): string {
  const n = normalizeDirection(d);
  if (n === "Buy") return "🟢";
  if (n === "Sell") return "🔴";
  return "🟡";
}

/**
 * 把过滤后的报告渲染为聊天卡片列表文本。
 * - filtered: 全部命中（用于"共 N 条"标题 + 截断计数）
 * - shown: 实际展示的切片（已 slice limit）
 * - q: 当前查询（标题反映 ticker 过滤）
 */
export function formatHistoryCards(
  filtered: ReportSummary[],
  shown: ReportSummary[],
  q: HistoryQuery,
): string {
  if (shown.length === 0) {
    return "## 历史报告 · 0 条\n没有匹配的报告。检查 report_dir 或放宽过滤条件。";
  }

  const lines: string[] = [];
  const total = filtered.length;

  // 标题：ticker 过滤显示公司名；否则截断时显示"共 N 条"
  let suffix = "";
  if (q.ticker) {
    const name = filtered[0]?.company_name || q.ticker;
    suffix = `（共 ${total} 条，已按 ${name} 过滤）`;
  } else if (total > shown.length) {
    suffix = `（共 ${total} 条）`;
  }
  lines.push(`## 历史报告 · ${shown.length} 条${suffix}`);
  lines.push("");

  for (const r of shown) {
    const date = r.date.length >= 10 ? r.date.slice(5) : r.date; // MM-DD
    const conf = `${Math.round((r.confidence || 0) * 100)}%`;
    const dur = formatElapsed(r.duration_ms || 0);
    const cost = `$${(r.total_cost_usd || 0).toFixed(2)}`;
    lines.push(`### ${dirEmoji(r.direction)} ${r.ticker} ${r.company_name} — ${date} ${r.mode}`);
    lines.push(`置信 ${conf} | 耗时 ${dur} | ${cost}`);
    const reasoning = (r.reasoning || "").trim();
    if (reasoning) {
      const excerpt = reasoning.length > 60 ? reasoning.slice(0, 60) + "…" : reasoning;
      lines.push(`> ${excerpt}`);
    }
    lines.push("");
  }

  if (total > shown.length) {
    lines.push(`> 还有 ${total - shown.length} 条，可按 ticker / 方向 / 日期范围 缩小范围。`);
  }
  lines.push("> 查看某条详情请用 trading_report。");
  return lines.join("\n");
}
