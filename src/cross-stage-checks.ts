// src/cross-stage-checks.ts

import { FullAnalysisResult, CrossStageIssue } from "./types";

// A Buy/Sell target more than this far from the current price is "absurd" — A
// shares move ±10-20%/day, so a 2x target is rarely credible in one horizon.
const ABSURD_TARGET_MULTIPLE = 2.0;
// A Buy target this far BELOW current (or Sell target above) is on the wrong
// side — a 5% buffer avoids flagging noise.
const WRONG_SIDE_BUFFER = 0.95;
// A bearish majority this strong conflicting with a Buy research call is a
// real disagreement, not noise: bears >= bulls + CONFLICT_MARGIN.
const CONFLICT_MARGIN = 2;

function isBullish(d: string): boolean {
  return d === "看多" || d === "Buy" || d === "Overweight";
}
function isBearish(d: string): boolean {
  return d === "看空" || d === "Sell" || d === "Underweight";
}

/**
 * Run all cross-stage consistency checks against a completed full analysis.
 * `latestClose` is the most recent close from the market data; checks that
 * need a market reference (target/stop side) are skipped when it's absent.
 */
export function crossStageChecks(
  result: FullAnalysisResult,
  latestClose?: number
): CrossStageIssue[] {
  const issues: CrossStageIssue[] = [];
  const plan = result.trading_plan;
  const dir = plan.direction;

  // ── target_price vs market ──
  if (latestClose && latestClose > 0 && plan.target_price > 0) {
    if (dir === "Buy" && plan.target_price < latestClose * WRONG_SIDE_BUFFER) {
      issues.push({
        severity: "warn",
        check: "target_price_band",
        message: `Buy 方向但目标价 ${plan.target_price} 低于现价 ${latestClose}（方向与目标价矛盾）`,
      });
    } else if (dir === "Sell" && plan.target_price > latestClose / WRONG_SIDE_BUFFER) {
      issues.push({
        severity: "warn",
        check: "target_price_band",
        message: `Sell 方向但目标价 ${plan.target_price} 高于现价 ${latestClose}（方向与目标价矛盾）`,
      });
    } else if (plan.target_price > latestClose * ABSURD_TARGET_MULTIPLE) {
      issues.push({
        severity: "warn",
        check: "target_price_band",
        message: `目标价 ${plan.target_price} 远偏离现价 ${latestClose}（>${Math.round((ABSURD_TARGET_MULTIPLE - 1) * 100)}%，可信度存疑）`,
      });
    }
  }

  // ── stop_loss side ──
  if (latestClose && latestClose > 0 && plan.stop_loss > 0) {
    if (dir === "Buy" && plan.stop_loss >= latestClose) {
      issues.push({
        severity: "warn",
        check: "stop_loss_side",
        message: `Buy 方向但止损价 ${plan.stop_loss} ≥ 现价 ${latestClose}（止损在入场价上方，逻辑错误）`,
      });
    } else if (dir === "Sell" && plan.stop_loss <= latestClose) {
      issues.push({
        severity: "warn",
        check: "stop_loss_side",
        message: `Sell 方向但止损价 ${plan.stop_loss} ≤ 现价 ${latestClose}（逻辑错误）`,
      });
    }
  }

  // ── conservative reject overruled ──
  const conservative = result.risk_debate.risk_arguments.find((a) => a.role === "conservative");
  if (
    conservative?.verdict === "reject" &&
    result.risk_assessment.status === "pass"
  ) {
    issues.push({
      severity: "warn",
      check: "conservative_overruled",
      message: "保守风控明确 reject，但风控经理最终 pass（多数票可能盖过了关键风险）",
    });
  }

  // ── analyst consensus vs research direction ──
  let bulls = 0;
  let bears = 0;
  for (const a of result.analysts) {
    const d = a.verdict?.direction || "";
    if (isBullish(d)) bulls++;
    else if (isBearish(d)) bears++;
  }
  const researchBuy = isBullish(result.research_decision.direction);
  const researchSell = isBearish(result.research_decision.direction);
  if (researchBuy && bears >= bulls + CONFLICT_MARGIN) {
    issues.push({
      severity: "warn",
      check: "consensus_conflict",
      message: `分析师明显看空（${bears} 空 vs ${bulls} 多），但研究方向为 Buy`,
    });
  } else if (researchSell && bulls >= bears + CONFLICT_MARGIN) {
    issues.push({
      severity: "warn",
      check: "consensus_conflict",
      message: `分析师明显看多（${bulls} 多 vs ${bears} 空），但研究方向为 Sell`,
    });
  }

  // ── retries exhausted (gave up revising) ──
  if (result.risk_assessment.retries_exhausted) {
    issues.push({
      severity: "warn",
      check: "retries_exhausted",
      message: "风控 revise 重试耗尽（仍未通过，非 clean pass）",
    });
  }

  // ── reject with a non-empty execution plan ──
  if (
    result.final.risk_assessment === "reject" &&
    result.final.execution_plan.trim().length > 0
  ) {
    issues.push({
      severity: "error",
      check: "reject_has_plan",
      message: "风控结论为 reject，但仍给出了非空执行计划（自相矛盾）",
    });
  }

  return issues;
}
