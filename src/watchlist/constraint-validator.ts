import type {
  ConstraintViolation, RebalancePlan,
  RebalanceConstraints, ValidationResult,
} from "./rebalance-types";

export interface ValidationContext {
  sectors: Map<string, string>;
  held: Map<string, { days_held: number; locked: boolean }>;
  tickersInPool: Set<string>;
  recentSoldTickers?: Set<string>;
  /** ticker → fitness score（shallow-analyzer 产物）。用于规则 11：fitness<7 禁止 BUY/ADD。 */
  fitnessByTicker?: Map<string, number>;
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

  // 规则 6: anti-churn 卖锁 — locked 持仓禁止 SELL/REDUCE
  for (const a of plan.actions) {
    if (a.action === "SELL" || a.action === "REDUCE") {
      const h = ctx.held.get(a.ticker);
      if (h?.locked) {
        violations.push({
          rule: "6. anti-churn 卖锁",
          detail: `${a.ticker} 持仓 ${h.days_held} 天 < anti_churn_days，locked，禁止 ${a.action}`,
        });
      }
    }
  }

  // 规则 7: anti-churn 买锁 — 最近 SELL 过的 ticker 禁止 BUY
  if (ctx.recentSoldTickers) {
    for (const a of plan.actions) {
      if (a.action === "BUY" && ctx.recentSoldTickers.has(a.ticker)) {
        violations.push({
          rule: "7. anti-churn 买锁",
          detail: `${a.ticker} 7 天内刚 SELL 过，禁止立即 BUY`,
        });
      }
    }
  }

  // 规则 8: action 一致性
  for (const a of plan.actions) {
    const inconsistent: string[] = [];
    if (a.action === "BUY" && a.current_weight > 0.0001) inconsistent.push("BUY 但 current>0");
    if (a.action === "SELL" && a.target_weight > 0.0001) inconsistent.push("SELL 但 target>0");
    if (a.action === "ADD" && a.current_weight < 0.0001) inconsistent.push("ADD 但 current=0");
    if (a.action === "ADD" && a.target_weight <= a.current_weight) inconsistent.push("ADD 但 target≤current");
    if (a.action === "REDUCE" && a.current_weight < 0.0001) inconsistent.push("REDUCE 但 current=0");
    if (a.action === "REDUCE" && a.target_weight <= 0) inconsistent.push("REDUCE 但 target≤0");
    if (a.action === "REDUCE" && a.target_weight >= a.current_weight) inconsistent.push("REDUCE 但 target≥current");
    if (a.action === "HOLD" && Math.abs(a.target_weight - a.current_weight) > 0.0001) inconsistent.push("HOLD 但 target≠current");
    if (inconsistent.length > 0) {
      violations.push({ rule: "8. action 一致性", detail: `${a.ticker} ${a.action}: ${inconsistent.join("; ")}` });
    }
  }

  // 规则 9: ticker 在候选/持仓池
  for (const a of plan.actions) {
    if (!ctx.tickersInPool.has(a.ticker)) {
      violations.push({
        rule: "9. ticker 在候选池",
        detail: `${a.ticker} 不在评估范围（幻觉 ticker）`,
      });
    }
  }

  // 规则 10: sector 非空
  for (const a of plan.actions) {
    if (a.target_weight > 0.0001 && !ctx.sectors.get(a.ticker)) {
      violations.push({
        rule: "10. sector 非空",
        detail: `${a.ticker} target>0 但 sector 缺失`,
      });
    }
  }

  // 规则 11: fitness 门槛 — fitness<7 的股禁止 BUY/ADD（等效入场信号拦截）
  if (ctx.fitnessByTicker) {
    for (const a of plan.actions) {
      if (a.action !== "BUY" && a.action !== "ADD") continue;
      const fitness = ctx.fitnessByTicker.get(a.ticker);
      if (typeof fitness === "number" && fitness < 7) {
        violations.push({
          rule: "11. fitness 门槛",
          detail: `${a.ticker} fitness=${fitness}<7，禁止 ${a.action}（需等待更高评分或数据改善）`,
        });
      }
    }
  }

  return { passed: violations.length === 0, violations };
}

/** 把 violations 拼成 LLM revise 用的 feedback 字符串。空 violations 返回空。 */
export function composeReviseFeedback(violations: ConstraintViolation[]): string {
  if (violations.length === 0) return "";
  const lines = violations.map((v, i) => `${i + 1}. [${v.rule}] ${v.detail}`);
  return [
    "你的上一次方案违反了以下约束，请修正：",
    "",
    ...lines,
    "",
    "请重新输出 REBALANCE_PLAN，确保满足所有硬约束。",
  ].join("\n");
}
