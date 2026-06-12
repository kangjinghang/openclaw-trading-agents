import { FullAnalysisResult, CrossStageIssue } from "./types";
/**
 * Run all cross-stage consistency checks against a completed full analysis.
 * `latestClose` is the most recent close from the market data; checks that
 * need a market reference (target/stop side) are skipped when it's absent.
 */
export declare function crossStageChecks(result: FullAnalysisResult, latestClose?: number): CrossStageIssue[];
//# sourceMappingURL=cross-stage-checks.d.ts.map