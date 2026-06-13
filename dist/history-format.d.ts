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
export declare function normalizeDirection(raw?: string): "Buy" | "Sell" | "Hold" | null;
/**
 * 多维 AND 过滤。所有维度可选；未提供的维度不过滤。
 * 方向维度：用户提供了 direction 但无法识别 → 返回空（视为"不匹配任何"）。
 */
export declare function filterReports(reports: ReportSummary[], q: HistoryQuery): ReportSummary[];
/**
 * 把过滤后的报告渲染为聊天卡片列表文本。
 * - filtered: 全部命中（用于"共 N 条"标题 + 截断计数）
 * - shown: 实际展示的切片（已 slice limit）
 * - q: 当前查询（标题反映 ticker 过滤）
 */
export declare function formatHistoryCards(filtered: ReportSummary[], shown: ReportSummary[], q: HistoryQuery): string;
//# sourceMappingURL=history-format.d.ts.map