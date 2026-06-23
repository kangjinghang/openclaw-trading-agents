import type { AnalystReport, RiskReport } from "./rebalance-types";
import type { StockData } from "./shallow-analyzer";
export interface QualityGateResult {
    /** clamp 后的 analyst 副本（不改原对象，避免污染调用方） */
    analyst: AnalystReport;
    /** clamp 后的 risk 副本 */
    risk: RiskReport;
    /** 可读 note，落 StockReport.quality_notes。空数组 = 无触发 */
    issues: string[];
}
export declare function applyQualityGate(analyst: AnalystReport, risk: RiskReport, data: StockData): QualityGateResult;
//# sourceMappingURL=quality-gate.d.ts.map