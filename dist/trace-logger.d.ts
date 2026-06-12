import { LLMCallTrace, FallbackWarning } from "./types";
export declare class TraceLogger {
    private traceDir;
    private _runId;
    private counter;
    private _totalTokens;
    private _totalCostUsd;
    private _warnings;
    constructor(traceDir: string, runId?: string);
    /** Record a single LLM call trace to disk as JSON, enriching with run_id */
    record(trace: LLMCallTrace): void;
    /** Get number of traces recorded */
    get count(): number;
    /** Get accumulated total tokens across all traces */
    get totalTokens(): number;
    /** Get accumulated total cost in USD across all traces */
    get totalCostUsd(): number;
    /** Get the run ID */
    get runId(): string;
    /**
     * Record a silent fallback that fired (parse → default/synonym/alternative).
     * `severity` defaults to "warn"; pass "error" for dangerous defaults like
     * risk → "pass" or a numeric field falling to 0. Kept on the TraceLogger so
     * warnings share the run's lifecycle without threading a collector through
     * every pure parse function.
     */
    recordWarning(warning: Omit<FallbackWarning, "severity"> & {
        severity?: FallbackWarning["severity"];
    }): void;
    /** Get all fallback warnings recorded this run */
    get warnings(): FallbackWarning[];
}
//# sourceMappingURL=trace-logger.d.ts.map