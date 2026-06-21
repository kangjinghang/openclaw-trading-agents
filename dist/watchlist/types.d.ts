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
 * 字段对应入选条件与上下文：
 *   - today_reason_points: A 类 — 今日 reason_list 原样（单点异动，不过滤 baseline）。
 *                          保留用于 derived/{date}-daily-candidates.json（用户写复盘用）。
 *   - continued_ranges:    B1 — 延续型区间（begin 在 baseline、today.end 变大、ongoing）
 *   - new_ranges:          B2 — 新成型区间（begin+end 不在 baseline、ongoing）
 *   - range_events:        B 类区间内的单日异动事件链（reason_list 过滤到 [range.begin, range.end]，
 *                          涨跌都留）。供下游 ranker LLM 看趋势演化。
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
    range_events: RawReason[];
}
/** 第2层：diff/{date}.json 结构 */
export interface DiffFile {
    scan_date: string;
    baseline: string;
    changes: DiffChange[];
}
/** 第3层：候选清单里的单股(每只 = 一个 diff range + 区间内事件链)。
 *
 * 设计原则:保留雪球的完整字段,不丢信息。
 *   - range:从 diff 的 continued_ranges[0] 或 new_ranges[0] 取,完整 8 字段
 *   - range_events:该 range 区间内的单日异动事件（涨跌都留），供 ranker LLM 看演化
 *
 * 排序:days 大 > |percent| 大(都是今日 end=今天 + 上涨的 range,ongoing 同质)。
 *
 * 注：今日是否活跃可从 range_events 过滤 timestamp===todayStartMs 得到。
 * daily-candidates.json（用户写复盘用）仍从 diff.json 的 today_reason_points 派生，不在本接口。
 */
export interface CandidateEntry {
    ticker: string;
    name: string;
    range: RawRange;
    range_kind: "continued" | "new";
    days: number;
    range_events: RawReason[];
}
/** 第3层：derived/{date}-candidates.json 结构。
 *
 * 只保留有 range 的股(B1 或 B2),丢弃只有 A 类 reason 的股(信号弱)。
 */
export interface CandidatesFile {
    scan_date: string;
    up: CandidateEntry[];
}
/** 第3层：单日异动榜的单股（今日上涨 reason，不看区间）。
 *  pct 从 description 提取（"涨幅X%"或"涨停"≈10），提取不出为 null。 */
export interface DailyCandidateEntry {
    ticker: string;
    name: string;
    pct: number | null;
    today_reasons: RawReason[];
}
/** 第3层：derived/{date}-daily-candidates.json 结构。按 pct 降序（null 排后）。 */
export interface DailyCandidatesFile {
    scan_date: string;
    up: DailyCandidateEntry[];
}
/** ranker 精排后的单条条目。
 *
 * LLM 只返回 `ticker / name / score / reason`；代码从输入 candidates 按 ticker 反查补
 * `percent / days / range_kind`，让看板无需回查原始文件。
 */
export interface RankedEntry {
    ticker: string;
    name: string;
    score: number;
    percent: number;
    days: number;
    range_kind: "continued" | "new";
    reason: string;
}
/** LLM 主动排除的股（仅给理由不评分）。 */
export interface ExcludedEntry {
    ticker: string;
    name: string;
    reason: string;
}
/** 单组（LONG 或 SHORT）的精排结果 = scan-long.json / scan-short.json。
 *
 * `fallback: true` 表示 LLM 失败、由规则打分降级产出，分数区间 4-6（明显低于 LLM 区）。
 * `distribution` 决策时该组候选的涨幅/天数分布快照，供事后复盘（市场走出来后
 * 对照决策时的分布判断 prompt 阈值是否合理）。
 */
export interface DistributionStats {
    min: number;
    p25: number;
    median: number;
    p75: number;
    max: number;
}
/** 决策时的分类计数（事后复盘用）。
 *  - range_kind: continued/new 各多少（prompt 里"延续型 > 新成型"权重的 review anchor）
 *  - today_catalyst: 今日催化强度分布（prompt 里"今日涨停/今日>5%/今日无=弱"的 review anchor）
 *    limit_up = description 含"涨停"；pct_over_5 = 提取出涨幅>5%；pct_under_5 = 今日有涨但≤5%；none = 今日无事件 */
export interface ScanGroupBreakdown {
    range_kind: {
        continued: number;
        new: number;
    };
    today_catalyst: {
        limit_up: number;
        pct_over_5: number;
        pct_under_5: number;
        none: number;
    };
}
export interface ScanGroupResult {
    scan_date: string;
    group: "LONG" | "SHORT";
    fallback: boolean;
    total_pre_filter?: number;
    total_post_common_filter?: number;
    total: number;
    distribution?: {
        percent: DistributionStats;
        days: DistributionStats;
    };
    breakdown?: ScanGroupBreakdown;
    ranked_count: number;
    excluded_count: number;
    ranked: RankedEntry[];
    excluded: ExcludedEntry[];
}
/** 合并的 scan.json 顶层结构。
 *
 * `top_picks` 跨组按 score 降序合并。下游 trading_quick 按 ticker 逐个处理，与分组无关。
 */
export interface ScanSummary {
    scan_date: string;
    total_candidates: number;
    groups: {
        LONG: {
            total: number;
            ranked: number;
            excluded: number;
            fallback: boolean;
        };
        SHORT: {
            total: number;
            pre_filter: number;
            post_common_filter: number;
            ranked: number;
            excluded: number;
            fallback: boolean;
        };
    };
    top_picks: Array<RankedEntry & {
        group: "LONG" | "SHORT";
    }>;
}
//# sourceMappingURL=types.d.ts.map