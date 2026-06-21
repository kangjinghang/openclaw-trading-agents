import type { ScanSummary } from "./types";
import type { Holdings } from "./rebalance-types";
export interface CandidateMeta {
    ticker: string;
    name: string;
    is_held: boolean;
    current_weight: number;
    days_held: number;
    locked: boolean;
    ranker_score?: number;
}
export interface SelectOptions {
    topN: number;
    currentDate: string;
    antiChurnDays: number;
}
export declare function selectCandidates(scan: ScanSummary, holdings: Holdings, opts: SelectOptions): CandidateMeta[];
//# sourceMappingURL=candidate-selector.d.ts.map