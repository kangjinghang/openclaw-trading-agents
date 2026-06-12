"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PipelineHealth = void 0;
/**
 * Collector for pipeline health issues. Instantiated once per run,
 * passed through each pipeline phase. Issues are registered via
 * check() (conditional) or add() (direct). At the end, toJSON()
 * produces the persistable array.
 */
class PipelineHealth {
    constructor(runId) {
        this.runId = runId;
        this._issues = [];
    }
    /** Register an issue directly. */
    add(issue) {
        this._issues.push(issue);
    }
    /**
     * Conditional check: if `condition` is false, registers an issue.
     * If true, does nothing (check passed).
     */
    check(stage, severity, checkName, condition, message, context) {
        if (!condition) {
            this._issues.push({ stage, severity, check: checkName, message, context });
        }
    }
    /** True if any issue has severity "abort" — caller should stop the pipeline. */
    get hasAbort() {
        return this._issues.some(i => i.severity === "abort");
    }
    /** All issues collected so far. */
    get issues() {
        return this._issues;
    }
    /** Get issues filtered by stage. */
    getIssues(stage) {
        return this._issues.filter(i => i.stage === stage);
    }
    /** Serialize for report persistence. */
    toJSON() {
        return this._issues;
    }
}
exports.PipelineHealth = PipelineHealth;
//# sourceMappingURL=pipeline-health.js.map