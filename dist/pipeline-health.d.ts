import { PipelineIssue } from "./types";
/**
 * Collector for pipeline health issues. Instantiated once per run,
 * passed through each pipeline phase. Issues are registered via
 * check() (conditional) or add() (direct). At the end, toJSON()
 * produces the persistable array.
 */
export declare class PipelineHealth {
    readonly runId: string;
    private _issues;
    constructor(runId: string);
    /** Register an issue directly. */
    add(issue: PipelineIssue): void;
    /**
     * Conditional check: if `condition` is false, registers an issue.
     * If true, does nothing (check passed).
     */
    check(stage: PipelineIssue["stage"], severity: PipelineIssue["severity"], checkName: string, condition: boolean, message: string, context?: Record<string, any>): void;
    /** True if any issue has severity "abort" — caller should stop the pipeline. */
    get hasAbort(): boolean;
    /** All issues collected so far. */
    get issues(): PipelineIssue[];
    /** Get issues filtered by stage. */
    getIssues(stage: string): PipelineIssue[];
    /** Serialize for report persistence. */
    toJSON(): PipelineIssue[];
}
//# sourceMappingURL=pipeline-health.d.ts.map