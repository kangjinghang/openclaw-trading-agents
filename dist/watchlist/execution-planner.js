"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildExecutionPlan = buildExecutionPlan;
/** 把 plan 的 actions 排序成可执行 sequence + cash 累计。 */
function buildExecutionPlan(plan, initialCash) {
    const actionable = plan.actions.filter(a => a.action !== "HOLD");
    const sorted = [...actionable].sort((a, b) => {
        if (a.priority !== b.priority)
            return a.priority - b.priority;
        return Math.abs(b.delta) - Math.abs(a.delta);
    });
    const steps = [];
    const warnings = [];
    let cash = initialCash;
    sorted.forEach((a, idx) => {
        const newCash = cash - a.delta;
        if (a.delta > 0 && newCash < -0.0001) {
            warnings.push(`${a.action} ${a.ticker} 需 ${a.delta.toFixed(3)} 但 cash 不足（剩余 ${cash.toFixed(3)})`);
        }
        const step = {
            step: idx + 1,
            action: a.action,
            ticker: a.ticker,
            name: a.name,
            weight_delta: a.delta,
            est_cash_after: Math.max(0, newCash),
            note: a.delta < 0 ? "释放资金" : (a.delta > 0 ? "使用资金" : undefined),
        };
        steps.push(step);
        cash = newCash;
    });
    return {
        execution_sequence: steps,
        final_state: plan.portfolio_after,
        warnings,
    };
}
//# sourceMappingURL=execution-planner.js.map