/** 第0层：universe 清单里的单股条目 */
export interface UniverseEntry {
    code: string;
    symbol: string;
    name: string;
}
/** 第0层：universe.json 结构 */
export interface UniverseFile {
    updated_at: string;
    source: string;
    total: number;
    stocks: UniverseEntry[];
}
/** 第1层：raw 快照里单股的雪球原始数据（原样存，字段都是雪球的） */
export interface RawStockEntry {
    name: string;
    reason_list?: RawReason[];
    range_reason_list?: RawRange[];
    scan_error?: string;
}
/** 雪球 reason_list 单元素（天级异动点） */
export interface RawReason {
    description: string;
    timestamp: number;
    reason: string;
    url?: string;
}
/** 雪球 range_reason_list 单元素（区间趋势） */
export interface RawRange {
    begin: number;
    end: number;
    type: "SHORT" | "LONG";
    percent: number;
    summary: string;
    points: string;
    url?: string;
    title?: string;
}
/** 第1层：raw/{date}.json 结构 */
export interface RawSnapshotFile {
    scan_date: string;
    begin_ms: number;
    end_ms: number;
    begin_date: string;
    end_date: string;
    window_months: number;
    scanned: number;
    succeeded: number;
    failed: number;
    stocks: Record<string, RawStockEntry>;
}
/** 第2层：diff/{date}.json 里单股的变更。
 *
 * 三个字段对应三类入选条件：
 *   - today_reason_points: A 类 — 今日 reason_list 原样（单点异动，不过滤 baseline）
 *   - continued_ranges:    B1 — 延续型区间（begin 在 baseline、today.end 变大、ongoing）
 *   - new_ranges:          B2 — 新成型区间（begin+end 不在 baseline、ongoing）
 *
 * 静止型（begin 相同但 end 不变）和非 ongoing 区间在 computeDiff 里直接丢弃，
 * 因为股票池是"今日有效"的语义：昨天结束的区间今天不再入选。
 */
export interface DiffChange {
    ticker: string;
    name: string;
    today_reason_points: RawReason[];
    continued_ranges: RawRange[];
    new_ranges: RawRange[];
}
/** 第2层：diff/{date}.json 结构 */
export interface DiffFile {
    scan_date: string;
    baseline: string;
    changes: DiffChange[];
}
/** 第3层：候选清单里的单股(每只 = 一个 diff range + 可选的今日涨 reason)。
 *
 * 设计原则:保留雪球的完整字段,不丢信息。
 *   - range:从 diff 的 continued_ranges[0] 或 new_ranges[0] 取,完整 8 字段
 *   - today_reasons:如果该股今日还有涨 reason,完整字段;否则空数组
 *
 * 排序:days 大 > |percent| 大(都是今日 end=今天 + 上涨的 range,ongoing 同质)。
 */
export interface CandidateEntry {
    ticker: string;
    name: string;
    range: RawRange;
    range_kind: "continued" | "new";
    days: number;
    today_reasons: RawReason[];
}
/** 第3层：derived/{date}-candidates.json 结构。
 *
 * 只保留有 range 的股(B1 或 B2),丢弃只有 A 类 reason 的股(信号弱)。
 */
export interface CandidatesFile {
    scan_date: string;
    up: CandidateEntry[];
}
//# sourceMappingURL=types.d.ts.map