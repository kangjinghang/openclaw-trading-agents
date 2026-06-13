/** Summary of a report for the list view */
export interface ReportSummary {
    id: string;
    run_id?: string;
    ticker: string;
    company_name: string;
    date: string;
    mode: "full" | "quick";
    created_at: string;
    duration_ms: number;
    total_tokens: number;
    total_cost_usd: number;
    direction: string;
    confidence: number;
    /** Final reasoning excerpt (from final.reasoning). Undefined in old reports. */
    reasoning?: string;
    analyst_verdicts: Record<string, {
        direction: string;
        reason: string;
    }>;
    trace_count: number;
    risk_assessment?: string;
    /** Full RiskAssessment object (review gap #4). Undefined in quick mode. */
    risk_assessment_detail?: {
        status: string;
        judge?: {
            verdict: string;
            reason: string;
            hard_constraints: string[];
            soft_constraints: string[];
            execution_preconditions: string[];
            de_risk_triggers: string[];
        };
        reasoning: string;
        risk_score: number;
        retries_exhausted?: boolean;
        max_position_override?: number;
    };
    warnings?: Array<{
        phase: string;
        fn: string;
        detail: string;
        severity: "warn" | "error";
    }>;
    cross_stage_issues?: Array<{
        severity: "warn" | "error";
        check: string;
        message: string;
    }>;
    pipeline_health?: Array<{
        stage: string;
        severity: string;
        check: string;
        message: string;
        context?: Record<string, any>;
    }>;
    /** Provenance chain — decision flow through pipeline stages (review gap #5). */
    provenance: Array<{
        stage: string;
        key_decision: string;
        detail_ref?: string;
    }>;
}
/** Scan report directory and return all report summaries */
export declare function listReports(reportDir: string): ReportSummary[];
/** Read a specific report JSON */
export declare function readReport(reportDir: string, ticker: string, dateMode: string): any | null;
/** Read a detail file from the report's detail directory */
export declare function readDetail(reportDir: string, ticker: string, dateMode: string, subPath: string): any | null;
/** Read all traces for a run_id from trace directories inside the report tree */
export declare function readTraces(reportDir: string, runId: string): any[];
/** Read traces by ticker and date from trace directories inside the report tree */
export declare function readTracesByTickerDate(reportDir: string, ticker: string, date: string): any[];
/** Read raw data source outputs from the report detail directory */
export declare function readDataSources(reportDir: string, ticker: string, dateMode: string): any[];
//# sourceMappingURL=dashboard-api.d.ts.map