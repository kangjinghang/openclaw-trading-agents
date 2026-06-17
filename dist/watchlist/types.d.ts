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
/** 第2层：diff/{date}.json 里单股的变更 */
export interface DiffChange {
    ticker: string;
    name: string;
    new_reason_points: RawReason[];
    new_range_trends: RawRange[];
}
/** 第2层：diff/{date}.json 结构 */
export interface DiffFile {
    scan_date: string;
    baseline: string;
    changes: DiffChange[];
}
/** 第3层：候选清单里该股的代表趋势（从其 range_reason_list 选出最强一条）。
 *
 * 注意：雪球的 type 是"分析窗口长度"（LONG=长周期/SHORT=短周期），
 * 不是涨跌方向。涨跌只看 percent 正负：正=上涨，负=下跌。
 */
export interface TopTrend {
    type: "SHORT" | "LONG";
    percent: number;
    days: number;
    ongoing: boolean;
}
/** 第3层：候选清单里的单股 */
export interface CandidateEntry {
    ticker: string;
    name: string;
    top_trend: TopTrend | null;
    new_today: {
        reasons: number;
        ranges: number;
    };
}
/** 第3层：derived/{date}-candidates.json 结构。
 *
 * 按 percent 正负拆成两组：
 *   up   —— 上涨趋势候选（percent > 0），用于找做多机会
 *   down —— 下跌趋势候选（percent < 0），用于找卖点/规避
 * 无区间趋势（top_trend=null）的股票归入 neutral，不参与 up/down 排序。
 */
export interface CandidatesFile {
    scan_date: string;
    up: CandidateEntry[];
    down: CandidateEntry[];
    neutral: CandidateEntry[];
}
//# sourceMappingURL=types.d.ts.map