// src/watchlist/quality-gate.ts
//
// 确定性质量门控（shallow-analyzer Layer-1）：在 analyst/risk 解析后、
// buildStockReport 前对 fitness / risk 做确定性钳制 + 标注，切断
// 「LLM 编造数据 → 错误 fitness → 错误仓位」的幻觉链。
//
// 为什么是内联守卫而非独立阶段：fitness 直接进 position-calculator 公式，
// 没有下游 LLM 再读。若只标注不钳制，幻觉数字会一路流到仓位。所以这里
// 既标注又钳制，必须内联在 analyzeAll 循环里。
//
// 趋势模式下的规则分两类：
// - 钳制型（通用守卫）：deal_breaker 一致性、fitness 越界、重大解禁兜底
// - 标注型：语义模糊无法自修，只记 issue 留给 rebalancer LLM / 人看
// 注：价值模式下的"PE=0 封顶"和"传闻封顶"已移除——趋势模式不因数据缺失
// 或传闻否决（动量可由传闻驱动），但 analyst prompt 会让 LLM 在 data_gaps 标注。

import type { AnalystReport, RiskReport } from "./rebalance-types";
import type { StockData } from "./shallow-analyzer";

export interface QualityGateResult {
  /** clamp 后的 analyst 副本（不改原对象，避免污染调用方） */
  analyst: AnalystReport;
  /** clamp 后的 risk 副本 */
  risk: RiskReport;
  /** 可读 note，落 StockReport.quality_notes。空数组 = 无触发 */
  issues: string[];
}

/** 传闻/未证实类关键词。趋势模式下仅标注（不钳制 fitness）——
 *  动量可由传闻驱动，但需诚实标注不确定性，让 rebalancer 知道这是传闻驱动的。 */
const RUMOR_TERMS = [
  "传闻", "传言", "市场传言", "未经证实", "尚未证实", "尚待证实", "尚待验证",
  "待证实", "据称", "疑似", "据传",
];

/** 把 ratio 字符串（如 "0.4%"/"5"）解析成数字，失败返回 NaN。
 *  lockup.py 的 shares/ratio 都是字符串，规则 7 要判 ratio≥5 需 parse。 */
function parseRatio(s: string | undefined): number {
  if (typeof s !== "string") return NaN;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : NaN;
}

export function applyQualityGate(
  analyst: AnalystReport,
  risk: RiskReport,
  data: StockData,
): QualityGateResult {
  const issues: string[] = [];
  // 副本，不动入参（LLM 原始输出可能被 trace 记录，保持原样可审计）
  let fitness = analyst.fitness_score;
  let overallRisk = risk.overall_risk;
  const dealBreaker = risk.deal_breaker;
  const thesis = analyst.thesis;

  // ── 钳制型（通用守卫）──────────────────────────────────

  // 规则 4（先做）：fitness 越界 → clamp 到 [0,10]
  // LLM 偶发输出 11 或负数，先归一化后续规则才有意义。
  if (fitness > 10 || fitness < 0) {
    const clamped = Math.max(0, Math.min(10, fitness));
    issues.push(`fitness ${fitness} 越界，clamp 到 ${clamped}`);
    fitness = clamped;
  }

  // 规则 3：deal_breaker 一致性。deal_breaker=true 意味灾难性风险，
  // overall_risk 必须是 high。
  if (dealBreaker && overallRisk !== "high") {
    issues.push(`deal_breaker=true 但 overall_risk=${overallRisk}，改为 high`);
    overallRisk = "high";
  }

  // 规则 7：重大解禁兜底。未来 90 天解禁 pressure_rating=重大压力，
  // 或 upcoming 任一条 ratio ≥ 5%（流通市值，供给冲击大），
  // 强制 overall_risk=high。防 LLM 漏判中期组合踩解禁洪峰的硬风险。
  // 仅在 lockup 数据存在时生效（拉取失败不臆测）。
  const lockup = data.lockup;
  if (lockup) {
    const majorPressure = lockup.pressure_rating === "重大压力";
    const bigUnlock = lockup.upcoming.some(it => {
      const r = parseRatio(it.ratio);
      return !isNaN(r) && r >= 5;
    });
    if ((majorPressure || bigUnlock) && overallRisk !== "high") {
      const reason = majorPressure
        ? "解禁压力评级=重大压力"
        : "未来90天有单笔解禁≥5%";
      issues.push(`${reason}，overall_risk=${overallRisk}→high（中期组合解禁兜底）`);
      overallRisk = "high";
    }
  }

  // ── 标注型（不改值，无法确定性地造出正确结论）──────────────

  // 规则 5：高风险无依据。标了 high 却没给任何 risk_flag，结论缺乏支撑。
  if (overallRisk === "high" && risk.risk_flags.length === 0) {
    issues.push("overall_risk=high 但 risk_flags 为空，结论缺支撑");
  }

  // 规则 6：thesis 过短。LLM 敷衍（如只回 "好"），下游无法据 thesis 复盘。
  if (thesis.trim().length < 20) {
    issues.push(`thesis 过短（${thesis.trim().length} 字符），可能敷衍`);
  }

  // 规则 8（标注型，趋势模式新增）：传闻标注。thesis 明示"未经证实"类信息，
  // 不钳制 fitness（趋势模式可做传闻驱动的动量），但标注让 rebalancer 知道不确定性。
  const hitRumor = RUMOR_TERMS.some(t => thesis.includes(t));
  if (hitRumor) {
    issues.push("thesis 含传闻/未证实信息，驱动逻辑不确定性较高");
  }

  return {
    analyst: { ...analyst, fitness_score: fitness },
    risk: { ...risk, overall_risk: overallRisk },
    issues,
  };
}
