import { QuickAnalysisResult, FullAnalysisResult, QualitySummary, QualityReview, FallbackWarning, CrossStageIssue, PipelineIssue, ProvenanceStage } from "./types";
export declare class ReportStore {
    private baseDir;
    constructor(baseDir: string);
    /** Write JSON to file atomically (write .tmp then rename), logging errors instead of crashing */
    private writeJson;
    /** Write plain text to file atomically (write .tmp then rename), logging errors instead of crashing */
    private writeText;
    /** Create directory, logging errors instead of crashing */
    private mkdir;
    /**
     * Save a quick analysis result to disk.
     * Creates: {baseDir}/{ticker}/{date}_quick.json (summary)
     *           {baseDir}/{ticker}/{date}_quick/01_analysts/*.json (details)
     */
    save(ticker: string, date: string, mode: "quick" | "full", result: QuickAnalysisResult, durationMs: number, totalTokens: number, totalCostUsd: number, runId?: string, warnings?: FallbackWarning[], pipelineHealth?: PipelineIssue[], provenance?: ProvenanceStage[]): void;
    /**
     * Save a full analysis result to disk with structured directory layout.
     */
    saveFull(ticker: string, date: string, result: FullAnalysisResult, durationMs: number, totalTokens: number, totalCostUsd: number, runId?: string, warnings?: FallbackWarning[], crossStageIssues?: CrossStageIssue[], pipelineHealth?: PipelineIssue[], provenance?: ProvenanceStage[]): void;
    /**
     * Persist the quality-gate output (Layer-1 grades + Layer-2 LLM review) to
     * `{detailDir}/00_quality.json`. The `00_` prefix places it ahead of the
     * phase outputs (01_analysts…) to signal it's a cross-cutting meta layer.
     *
     * Call this RIGHT AFTER the quality gate computes — before the expensive
     * debate/research/trader/risk phases — so a mid-run crash still leaves the
     * quality audit on disk. Previously this data was only injected into
     * downstream prompts (transient) and logged to progress; after the run it
     * was unrecoverable without grepping trace prompt inputs.
     *
     * `qualityReview` is null when Layer-2 is skipped (≥4 Layer-1 hard-fails)
     * or its LLM call fails — in that case layer2 is persisted as null so
     * consumers can distinguish "ran and found nothing" from "didn't run".
     */
    saveQualitySummary(ticker: string, date: string, mode: "quick" | "full", quality: QualitySummary, qualityReview: QualityReview | null): void;
}
//# sourceMappingURL=report-store.d.ts.map