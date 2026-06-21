import type { Action, ExecutionPlan, ExecutionStep, RebalancePlan } from "./rebalance-types";

/** 把 plan 的 actions 排序成可执行 sequence + cash 累计。 */
export function buildExecutionPlan(plan: RebalancePlan, initialCash: number): ExecutionPlan {
  const actionable = plan.actions.filter(a => a.action !== "HOLD");

  const sorted = [...actionable].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return Math.abs(b.delta) - Math.abs(a.delta);
  });

  const steps: ExecutionStep[] = [];
  const warnings: string[] = [];
  let cash = initialCash;
  sorted.forEach((a, idx) => {
    const newCash = cash - a.delta;
    if (a.delta > 0 && newCash < -0.0001) {
      warnings.push(`${a.action} ${a.ticker} 需 ${a.delta.toFixed(3)} 但 cash 不足（剩余 ${cash.toFixed(3)})`);
    }
    const step: ExecutionStep = {
      step: idx + 1,
      action: a.action as Exclude<Action["action"], "HOLD">,
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
