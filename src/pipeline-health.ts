import { PipelineIssue } from "./types";

/**
 * Collector for pipeline health issues. Instantiated once per run,
 * passed through each pipeline phase. Issues are registered via
 * check() (conditional) or add() (direct). At the end, toJSON()
 * produces the persistable array.
 */
export class PipelineHealth {
  private _issues: PipelineIssue[] = [];

  constructor(public readonly runId: string) {}

  /** Register an issue directly. */
  add(issue: PipelineIssue): void {
    this._issues.push(issue);
  }

  /**
   * Conditional check: if `condition` is false, registers an issue.
   * If true, does nothing (check passed).
   */
  check(
    stage: PipelineIssue["stage"],
    severity: PipelineIssue["severity"],
    checkName: string,
    condition: boolean,
    message: string,
    context?: Record<string, any>
  ): void {
    if (!condition) {
      this._issues.push({ stage, severity, check: checkName, message, context });
    }
  }

  /** True if any issue has severity "abort" — caller should stop the pipeline. */
  get hasAbort(): boolean {
    return this._issues.some(i => i.severity === "abort");
  }

  /** All issues collected so far. */
  get issues(): PipelineIssue[] {
    return this._issues;
  }

  /** Get issues filtered by stage. */
  getIssues(stage: string): PipelineIssue[] {
    return this._issues.filter(i => i.stage === stage);
  }

  /** Serialize for report persistence. */
  toJSON(): PipelineIssue[] {
    return this._issues;
  }
}
