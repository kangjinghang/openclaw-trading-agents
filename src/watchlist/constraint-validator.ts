import type {
  ConstraintViolation, RebalancePlan,
  RebalanceConstraints, ValidationResult,
  StockReport,
} from "./rebalance-types";

export interface ValidationContext {
  sectors: Map<string, string>;
  /** held 持仓信息：locked（<anti_churn_days）+ stopLossSignal（止损信号，可突破锁）
   *  + takeProfitSignal（止盈信号：浮盈≥阈值，可突破锁卖出，落袋为安不是 churn） */
  held: Map<string, { days_held: number; locked: boolean; stopLossSignal?: boolean; takeProfitSignal?: boolean }>;
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
    if (a.target_weight > c.single_name + 0.001) {
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
    if (sum > c.single_sector + 0.001) {
      violations.push({
        rule: "3. 单行业上限",
        detail: `${sector} 行业 sum ${sum.toFixed(3)} 超 ${c.single_sector} 上限`,
      });
    }
  }

  // 规则 4: 日换手 ≤ daily_turnover
  //   算法：单向 max(总买入, 总卖出)，不是双向 sum(|delta|)。
  //   原因：满仓后一次"换仓"（卖旧买新）天然双向累加——卖 30%+买 20%=50%，任何 2 只以上的
  //   换仓都必超 40% 上限，数学上不可满足，导致满仓后策略卡死（死亡螺旋）。
  //   单向只算较大的一边：同样换仓 max(30%,20%)=30%，合理反映"真实换了多少仓位"。
  //   （净加仓=只买不卖、净降仓=只卖不买时，单向=双向，不受影响。）
  const buyTotal = plan.actions.reduce((s, a) => s + Math.max(0, a.delta), 0);
  const sellTotal = plan.actions.reduce((s, a) => s + Math.max(0, -a.delta), 0);
  const turnover = Math.max(buyTotal, sellTotal);
  if (turnover > c.daily_turnover + 0.001) {
    violations.push({
      rule: "4. 日换手上限",
      detail: `max(买${buyTotal.toFixed(3)}, 卖${sellTotal.toFixed(3)}) = ${turnover.toFixed(3)} 超 ${c.daily_turnover} 上限`,
    });
  }

  // 规则 5: 现金 ≥ cash_reserve
  if (plan.portfolio_after.cash_pct < c.cash_reserve - 0.001) {
    violations.push({
      rule: "5. 现金下限",
      detail: `cash_pct ${plan.portfolio_after.cash_pct.toFixed(3)} 不足 ${c.cash_reserve} 下限`,
    });
  }

  // 规则 6: anti-churn 卖锁 — locked 持仓禁止 SELL/REDUCE
  //   止损豁免：overall_risk=high 或有 severity=高 的 risk_flag（stopLossSignal=true）时
  //   允许突破锁及时止损。anti-churn 防"无谓 churn"，止损是退出不是 churn。
  //   趋势策略的下行保护依赖破位即卖，不能被锁堵死（否则等于没有止损）。
  //   止盈豁免：浮盈≥take_profit_threshold（takeProfitSignal=true）时允许突破锁卖出。
  //   止盈是合理操作（落袋为安/换更强标的），不该被 churn 锁挡死。与止损镜像：锁防噪音，
  //   不锁真正的退出动机（止损下行 + 止盈上行）。
  for (const a of plan.actions) {
    if (a.action === "SELL" || a.action === "REDUCE") {
      const h = ctx.held.get(a.ticker);
      if (h?.locked && !h.stopLossSignal && !h.takeProfitSignal) {
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
    if (a.action === "BUY" && a.current_weight > 0.001) inconsistent.push("BUY 但 current>0");
    if (a.action === "SELL" && a.target_weight > 0.001) inconsistent.push("SELL 但 target>0");
    if (a.action === "ADD" && a.current_weight < 0.001) inconsistent.push("ADD 但 current=0");
    if (a.action === "ADD" && a.target_weight <= a.current_weight) inconsistent.push("ADD 但 target≤current");
    if (a.action === "REDUCE" && a.current_weight < 0.001) inconsistent.push("REDUCE 但 current=0");
    if (a.action === "REDUCE" && a.target_weight <= 0) inconsistent.push("REDUCE 但 target≤0");
    if (a.action === "REDUCE" && a.target_weight >= a.current_weight) inconsistent.push("REDUCE 但 target≥current");
    if (a.action === "HOLD" && Math.abs(a.target_weight - a.current_weight) > 0.001) inconsistent.push("HOLD 但 target≠current");
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
    if (a.target_weight > 0.001 && !ctx.sectors.get(a.ticker)) {
      violations.push({
        rule: "10. sector 非空",
        detail: `${a.ticker} target>0 但 sector 缺失`,
      });
    }
  }

  // 规则 11: fitness 门槛 — 趋势模式下 fitness<4 的股禁止 BUY/ADD（驱动逻辑极弱）
  // 注：价值模式门槛是 7，趋势模式降到 4（小分给小仓，靠止损退出不靠否决）
  if (ctx.fitnessByTicker) {
    for (const a of plan.actions) {
      if (a.action !== "BUY" && a.action !== "ADD") continue;
      const fitness = ctx.fitnessByTicker.get(a.ticker);
      if (typeof fitness === "number" && fitness < 4) {
        violations.push({
          rule: "11. fitness 门槛",
          detail: `${a.ticker} fitness=${fitness}<4，禁止 ${a.action}（驱动逻辑极弱）`,
        });
      }
    }
  }

  // 规则 12: 持仓数 ≤ max_positions
  //   落实"3-5 只集中"定位——之前只是 prompt 软引导，LLM 无视它买到 7-8 只，仓位打满后
  //   触发换手率死亡螺旋。现在硬约束 target>0 的 action 数。是上限不是必须达到（手数取整
  //   买不足一手被跳过时，实际持仓少于上限不算违规）。
  if (typeof c.max_positions === "number") {
    const heldCount = plan.actions.filter(a => a.target_weight > 0.001).length;
    if (heldCount > c.max_positions) {
      violations.push({
        rule: "12. 持仓数上限",
        detail: `持仓 ${heldCount} 只 超 ${c.max_positions} 上限（需砍掉 ${heldCount - c.max_positions} 只：优先 SELL fitness 最低/趋势已破位的）`,
      });
    }
  }

  return { passed: violations.length === 0, violations };
}

/** revise 反馈的可选上下文：给 LLM 更具体的修正指引。
 *  - overSectors：超限行业集合（从违规 detail 解析），用于告诉 LLM "别再往这些行业加仓"
 *  - reports：候选股报告，用于筛出"非超限行业的强标的"推荐给 LLM 转向
 *
 *  这是阶段 13 的核心：候选池偏科时（如电子占 60%），LLM 撞行业上限后不会转向，
 *  死磕同行业。给它具体的非超限行业强标的清单（如中科曙光/巨化股份），它才有出路。 */
export interface FeedbackContext {
  overSectors?: Set<string>;
  reports?: StockReport[];
}

/** 把 violations 拼成 LLM revise 用的 feedback 字符串。空 violations 返回空。
 *  关键：不只是报错，还要给可执行的修正指引——否则 LLM 不知道该砍哪个动作，盲目重试
 *  往往收敛不了（这正是之前满仓卡死时 revise 2 次仍失败的原因之一）。 */
export function composeReviseFeedback(
  violations: ConstraintViolation[],
  ctx?: FeedbackContext,
): string {
  if (violations.length === 0) return "";
  const lines = violations.map((v, i) => `${i + 1}. [${v.rule}] ${v.detail}`);

  // 针对高频违规补可执行指引
  const tips: string[] = [];
  if (violations.some(v => v.rule.includes("持仓数上限"))) {
    tips.push("- 持仓超限：砍掉 fitness 最低或趋势已破位的持仓（改 SELL），不要只把目标仓位调小——数量没减还是违规");
  }
  if (violations.some(v => v.rule.includes("日换手上限"))) {
    tips.push("- 换手超限：减少【同时进行的买卖对数】。优先只做最该做的 1-2 笔，其余改 HOLD 下次再调");
  }
  if (violations.some(v => v.rule.includes("anti-churn 卖锁"))) {
    tips.push("- 撞卖锁：被锁的持仓禁止 SELL/REDUCE（除非止损/止盈信号）。变通方式：①把那只改 HOLD，等解锁后再卖 "
      + "②改卖其他没锁的持仓 ③只做买入不做卖出。不要死磕同一只被锁的标的");
  }
  // 行业超限：最关键的指引——给 LLM 非超限行业的强标的清单，让它转向（而不是死磕同行业）
  if (violations.some(v => v.rule.includes("单行业上限"))) {
    const overSectors = ctx?.overSectors ?? new Set<string>();
    const overStr = overSectors.size > 0 ? Array.from(overSectors).join("/") : "超限行业";
    tips.push(`- 行业超限：${overStr} 已满，不要再往这些行业 BUY/ADD。应转向【其他行业的强标的】。`);

    // 筛出非超限行业、未超 single_name、fitness≥7 的候选，作为"可转向"清单
    const reports = ctx?.reports ?? [];
    const alts = reports
      .filter(r => !overSectors.has(r.sector) && !r.deal_breaker && r.fitness_score >= 7)
      .sort((a, b) => (b.fitness_score ?? 0) - (a.fitness_score ?? 0))
      .slice(0, 5);
    if (alts.length > 0) {
      const altStr = alts.map(a => `${a.name}(${a.sector},fit${a.fitness_score})`).join("、");
      tips.push(`- 候选池中非${overStr}行业的强标的（可转向配置）：${altStr}`);
    }
  }

  return [
    "你的上一次方案违反了以下约束，请修正：",
    "",
    ...lines,
    ...(tips.length > 0 ? ["", "修正建议：", ...tips] : []),
    "",
    "请重新输出 REBALANCE_PLAN，确保满足所有硬约束。",
  ].join("\n");
}
