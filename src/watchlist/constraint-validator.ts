import type {
  ConstraintViolation, RebalancePlan,
  RebalanceConstraints, ValidationResult,
} from "./rebalance-types";

export interface ValidationContext {
  sectors: Map<string, string>;
  held: Map<string, { days_held: number; locked: boolean }>;
  tickersInPool: Set<string>;
  recentSoldTickers?: Set<string>;
}

export function validateRebalance(
  plan: RebalancePlan,
  ctx: ValidationContext,
  c: RebalanceConstraints,
): ValidationResult {
  const violations: ConstraintViolation[] = [];

  // 规则 1: 权重和=1（含 HOLD 的 target_weight）
  const sumWeight = plan.actions.reduce((s, a) => s + a.target_weight, 0);
  const totalWithCash = sumWeight + plan.portfolio_after.cash_pct;
  if (Math.abs(totalWithCash - 1.0) > 0.001) {
    violations.push({
      rule: "1. 权重和=1",
      detail: `权重和 ${totalWithCash.toFixed(3)} 不等于 1.0（positions ${sumWeight.toFixed(3)} + cash ${plan.portfolio_after.cash_pct.toFixed(3)}）`,
    });
  }

  // 规则 2: 单仓 ≤ single_name
  for (const a of plan.actions) {
    if (a.target_weight > c.single_name + 0.0001) {
      violations.push({
        rule: "2. 单仓上限",
        detail: `${a.ticker} target_weight ${a.target_weight.toFixed(3)} 超 ${c.single_name} 上限`,
      });
    }
  }

  // 规则 3: 单行业 ≤ single_sector
  const sectorSums = new Map<string, number>();
  for (const a of plan.actions) {
    if (a.target_weight <= 0) continue;
    const sector = ctx.sectors.get(a.ticker);
    if (!sector) continue;
    sectorSums.set(sector, (sectorSums.get(sector) ?? 0) + a.target_weight);
  }
  for (const [sector, sum] of sectorSums) {
    if (sum > c.single_sector + 0.0001) {
      violations.push({
        rule: "3. 单行业上限",
        detail: `${sector} 行业 sum ${sum.toFixed(3)} 超 ${c.single_sector} 上限`,
      });
    }
  }

  // 规则 4: 日换手 ≤ daily_turnover
  const turnover = plan.actions.reduce((s, a) => s + Math.abs(a.delta), 0);
  if (turnover > c.daily_turnover + 0.0001) {
    violations.push({
      rule: "4. 日换手上限",
      detail: `sum(|delta|) ${turnover.toFixed(3)} 超 ${c.daily_turnover} 上限`,
    });
  }

  // 规则 5: 现金 ≥ cash_reserve
  if (plan.portfolio_after.cash_pct < c.cash_reserve - 0.0001) {
    violations.push({
      rule: "5. 现金下限",
      detail: `cash_pct ${plan.portfolio_after.cash_pct.toFixed(3)} 不足 ${c.cash_reserve} 下限`,
    });
  }

  return { passed: violations.length === 0, violations };
}
