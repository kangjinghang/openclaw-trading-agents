// src/watchlist/position-calculator.ts
//
// 确定性仓位计算器（趋势跟随模式）：把 target_weight 的决定权从 LLM 手里拿走，
// 交给可解释、可复盘的公式。LLM 只决定方向（BUY/SELL/ADD/REDUCE/HOLD），
// 具体数字由公式根据 fitness + 波动率算出。
//
// 趋势模式公式主轴：目标仓位 = 基础仓位(fitness 线性映射) × 波动率折扣
// 再经：现金排队（按分数花钱）+ 单仓上限钳制
//
// 与价值模式的核心差异：
// - fitness 全程有仓位（线性，无"≤6 不买"断崖）——趋势模式要在场，小分给小仓
// - 去掉 riskFactor 打折——risk=high 靠技术位止损退出，不靠仓位压缩
// - deal_breaker 是唯一硬退出（强制清仓）

import type {
  Action,
  ActionType,
  RebalanceConstraints,
  RebalancePlan,
  StockReport,
} from "./rebalance-types";

// ── 配置档位（趋势档） ───────────────────────────────────────────────────

/** action 类型 → priority（execution-planner 排序用）。
 *  SELL=1（先释放资金）→ REDUCE=2 → BUY=3 → ADD=4 → HOLD=5（最后）。
 *  与 rebalance-types.ts Action.priority 注释一致。 */
export function actionPriority(action: ActionType): number {
  switch (action) {
    case "SELL": return 1;
    case "REDUCE": return 2;
    case "BUY": return 3;
    case "ADD": return 4;
    case "HOLD": return 5;
  }
}

/** fitness 分数 → 基础仓位（折扣前）。
 *  趋势模式线性映射：fitness 全程有仓位，无"≤6 不买"断崖。
 *  每分 0.8%：fit3→2.4%, fit5→4%, fit7→5.6%, fit9→7.2%, fit10→8%。
 *  受 singleNameCap（默认 10%）钳制。 */

// ── 技术破位识别（趋势策略退出信号）──────────────────────────────────────
// risk=high 分两类：
//   ① 技术破位（MACD死叉/量价背离/缩量下跌/跌破支撑/缩量上涨）→ 趋势可能结束，代码强制 REDUCE
//   ② 非技术类（减持/解禁/估值/业绩/造假）→ 留给 PM 判断，不强制
// 与 shallow-analyzer.ts 退出信号识别规则对齐。
const TECHNICAL_BREAKDOWN_KEYWORDS = [
  "MACD", "死叉", "量价背离", "价量背离", "缩量下跌", "缩量上涨",
  "跌破支撑", "破位", "趋势反转", "见顶", "抛压",
];

/** 判断 report 是否含技术破位类高危 risk_flag（severity=高 + flag 命中关键词）。
 *  命中 → 趋势策略代码层强制 REDUCE，不留给 PM 犹豫（PM 保守倾向下倾向 HOLD）。 */
export function hasTechnicalBreakdown(report: StockReport): boolean {
  if (!report.risk_flags || report.risk_flags.length === 0) return false;
  return report.risk_flags.some(f =>
    f.severity === "高"
    && TECHNICAL_BREAKDOWN_KEYWORDS.some(kw => f.flag.includes(kw) || f.detail.includes(kw))
  );
}

// fitness → 基础仓位（趋势模式线性映射）。
// 系数演进：0.008（初值，fit8=6.4%太轻）→ 0.015（06-27，仍不够）→ 0.022（06-28 方向B）。
// 0.022 的决策链：诊断出"fitness偏低(avg5.3)→小仓→满不了仓"死循环后，配合评分标准放宽，
// 让 fit7-8 能拿 14-17% 仓位，3-5 只集中可达 60%+ 仓位。回测验证：仓位 38%→63%。
// 完整推理见 docs/backtest-evolution.md 决策C。调参前先看 docs/backtest-params.md。
export function baseWeight(fitness: number): number {
  const clamped = Math.max(0, Math.min(10, fitness));
  return clamped * 0.022; // 线性：fit3=6.6%, fit5=11%, fit7=15.4%, fit8=17.6%, fit10=22%（小账户集中定位）
}

/** 波动率折扣：日线收益率标准差（单位 %，如 2.5 = 2.5%/日，由 computeVolatility 输出）。
 *  0（kline 失败/未知）→ ×0.6（最保守折扣，防"零风险"假象）。
 *  <2%/日 → ×1.0（大盘股），2-4% → ×0.8（成长股），>4% → ×0.6（题材/次新）。 */
export function volatilityFactor(volatility: number): number {
  if (volatility <= 0) return 0.6;   // 未知波动率 → 最保守
  if (volatility < 2) return 1.0;    // <2%/日 大盘股
  if (volatility < 4) return 0.8;    // 2-4%/日 成长股
  return 0.6;                         // >4%/日 题材/次新
}

/** 趋势模式已移除 riskFactor——risk=high 靠技术位止损（risk prompt 输出退出信号
 *  → rebalancer 触发 SELL/REDUCE），不靠仓位压缩。保留导出以避免下游 import 断裂
 *  （返回固定 1.0，语义为"risk 不打折仓位"）。 */
export function riskFactor(_overallRisk: "low" | "medium" | "high"): number {
  return 1.0;
}

// ── 单股仓位计算 ───────────────────────────────────────────────────────────

export interface PositionInput {
  action: ActionType;           // LLM 给的方向
  report: StockReport;          // 该股的 shallow-analyzer 报告（含 fitness/risk/deal_breaker）
  currentWeight: number;        // 当前仓位（候选股=0）
  volatility: number;           // 20日波动率（来自 data-fetcher，StockData.kline.volatility_20d）
  singleNameCap: number;        // 单仓上限（constraints.single_name，默认 0.15）
  // ── 建仓回撤止损（可选，仅持仓股传入）──
  /** 建仓价（持仓股的 Position.entry_price）。候选股无此字段。 */
  entryPrice?: number;
  /** 当前收盘价（StockData.kline.last_close）。 */
  currentPrice?: number;
  /** 持仓天数（selectCandidates 算好的 days_held）。 */
  daysHeld?: number;
  /** 建仓回撤止损阈值（constraints.initial_stop_drawdown，如 0.07 = -7%）。 */
  initialStopDrawdown?: number;
  /** 建仓回撤止损窗口（constraints.initial_stop_days，如 3 天）。 */
  initialStopDays?: number;
}

export interface PositionResult {
  /** 最终目标仓位（0-1） */
  targetWeight: number;
  /** 计算溯源，便于复盘和审计（如 "9分基础7% × 波动率0.8 × 风险1.0 = 5.6%"） */
  trace: string;
}

/** 算出单只股票的目标仓位。
 *  纯函数，无副作用，可独立测试。 */
export function computePosition(input: PositionInput): PositionResult {
  const { action, report, currentWeight, volatility, singleNameCap } = input;

  // SELL：清仓（最高优先级，deal_breaker 也走这里）
  if (action === "SELL") {
    return { targetWeight: 0, trace: "SELL：清仓至 0%" };
  }

  // deal_breaker：无论 AI 给什么方向（除已 SELL 外），强制 SELL（防 AI 漏判致命雷）
  if (report.deal_breaker) {
    return { targetWeight: 0, trace: `deal_breaker 强制清仓（AI 出 ${action}，致命雷覆盖）` };
  }

  // 建仓回撤止损（initial stop）：建仓 ≤N 天内从 entry_price 回撤 ≥X% → 强制清仓。
  // 补技术信号盲区：建仓次日大跌但未跌破支撑/量比正常时，纯技术信号不触发（国瓷案例）。
  // 与 deal_breaker 同模式：机械规则，确定性执行，不依赖 PM 判断。
  if (report.is_held
      && input.entryPrice && input.entryPrice > 0
      && input.currentPrice && input.currentPrice > 0
      && typeof input.daysHeld === "number"
      && typeof input.initialStopDrawdown === "number"
      && typeof input.initialStopDays === "number"
      && input.daysHeld <= input.initialStopDays) {
    const drawdown = (input.currentPrice / input.entryPrice - 1);  // 负值 = 亏损
    if (drawdown <= -input.initialStopDrawdown) {
      const pct = (drawdown * 100).toFixed(1);
      return {
        targetWeight: 0,
        trace: `建仓${input.daysHeld}天回撤${pct}% ≤ -${(input.initialStopDrawdown * 100).toFixed(0)}%，强制止损`,
      };
    }
  }

  // 技术破位强制 REDUCE：持仓股 risk=high 且有技术破位类高危 flag（MACD死叉/量价背离/
  // 缩量下跌/跌破支撑等）→ 代码强制减半，不留给 PM 犹豫（PM 保守倾向下倾向 HOLD）。
  // 区别于 deal_breaker（清仓）：技术破位是趋势可能结束，减仓而非清仓，留观察余地。
  // 非技术类高危 flag（减持/解禁/估值）不强制，留给 PM 判断。
  if (report.is_held && currentWeight > 0 && hasTechnicalBreakdown(report)) {
    const techFlag = report.risk_flags.find(f =>
      f.severity === "高" && TECHNICAL_BREAKDOWN_KEYWORDS.some(kw => f.flag.includes(kw) || f.detail.includes(kw))
    );
    const target = currentWeight / 2;
    return {
      targetWeight: target,
      trace: `技术破位（${techFlag?.flag ?? "?"}）强制 REDUCE：${(currentWeight * 100).toFixed(1)}% → ${(target * 100).toFixed(1)}%`,
    };
  }

  // HOLD：不动，保持当前仓位（deal_breaker 已在上一步拦截）
  if (action === "HOLD") {
    return { targetWeight: currentWeight, trace: `HOLD：维持当前 ${(currentWeight * 100).toFixed(1)}%` };
  }

  // REDUCE：减半；若仓位已很小（≤3%，即 fitness 7 的基础档），直接清仓（省一个换手槽位）
  if (action === "REDUCE") {
    if (currentWeight <= 0.03) {
      return { targetWeight: 0, trace: `REDUCE：当前 ${(currentWeight * 100).toFixed(1)}% ≤3%，直接清仓` };
    }
    const target = currentWeight / 2;
    return {
      targetWeight: target,
      trace: `REDUCE：当前 ${(currentWeight * 100).toFixed(1)}% 减半 → ${(target * 100).toFixed(1)}%`,
    };
  }

  // ADD：加到基础仓位档为止，不到就不动（max(当前, 基础档)）
  // 注意：ADD 不打折，因为已经是持仓，波动率/风险在当初 BUY 时已考虑
  if (action === "ADD") {
    const base = baseWeight(report.fitness_score);
    if (base === 0) {
      return { targetWeight: currentWeight, trace: `ADD 但 fitness ${report.fitness_score} ≤6，维持当前` };
    }
    const rawTarget = Math.max(currentWeight, base);
    const capped = Math.min(rawTarget, singleNameCap);
    return {
      targetWeight: capped,
      trace: `ADD：max(当前 ${(currentWeight * 100).toFixed(1)}%, 基础 ${(base * 100).toFixed(1)}%) → ${(capped * 100).toFixed(1)}%`,
    };
  }

  // BUY：基础仓位 × 波动率折扣（趋势模式：去掉 riskFactor，fitness 全程有仓位）
  const base = baseWeight(report.fitness_score);
  if (base === 0) {
    // fitness=0 才不买（防御性，趋势模式 fitness≥1 即可小仓试探）
    return { targetWeight: 0, trace: `fitness ${report.fitness_score}，BUY 不生效` };
  }

  const volF = volatilityFactor(volatility);
  const raw = base * volF;
  const capped = Math.min(raw, singleNameCap);

  return {
    targetWeight: capped,
    trace: `BUY：${report.fitness_score}分基础 ${(base * 100).toFixed(1)}% × 波动率${volF}(${(volatility * 100).toFixed(1)}%) = ${(capped * 100).toFixed(2)}%`,
  };
}

// ── 批量改写 plan ──────────────────────────────────────────────────────────

export interface ApplyPositionsContext {
  /** ticker → StockReport（shallow-analyzer 产物） */
  reportsByTicker: Map<string, StockReport>;
  /** ticker → volatility_20d（来自 data-fetcher，StockData.kline） */
  volatilityByTicker: Map<string, number>;
  /** 硬约束（取 single_name 作单仓上限，cash_reserve 作现金下限） */
  constraints: RebalanceConstraints;
  /** 初始现金（holdings.cash_pct），用于现金排队 */
  initialCash: number;
  // ── 建仓回撤止损所需数据（rebalancer pipeline 预抽）──
  /** ticker → entry_price（持仓股的建仓价，候选股无此键） */
  entryPriceByTicker?: Map<string, number>;
  /** ticker → 当前收盘价（StockData.kline.last_close） */
  currentPriceByTicker?: Map<string, number>;
  /** ticker → 持仓天数（selectCandidates 算好的 days_held） */
  daysHeldByTicker?: Map<string, number>;
}

/** 改写 plan 的所有 actions：把 LLM 给的 target_weight/delta 替换为公式算出的值。
 *  同时重算 portfolio_after 和 cash_pct，保证 validator 规则 1（权重和=1）通过。
 *
 *  返回新 plan（不改原对象）+ 每只股的计算溯源（便于审计/复盘）。 */
export function applyPositions(
  plan: RebalancePlan,
  ctx: ApplyPositionsContext,
): { plan: RebalancePlan; traces: Map<string, string> } {
  const { reportsByTicker, volatilityByTicker, constraints, initialCash } = ctx;
  const singleNameCap = constraints.single_name;

  // 第一遍：算出每个 action 的目标仓位（不含现金排队）
  const newActions: Action[] = [];
  const traces = new Map<string, string>();

  for (const a of plan.actions) {
    const report = reportsByTicker.get(a.ticker);
    const currentWeight = a.current_weight;
    const volatility = volatilityByTicker.get(a.ticker) ?? 0;

    if (!report) {
      // 无报告的 action（理论不该发生，防御性）：HOLD 保持当前，其他清零
      const fallbackTarget = a.action === "HOLD" ? currentWeight : 0;
      const fallback: Action = {
        ...a,
        target_weight: fallbackTarget,
        delta: fallbackTarget - currentWeight,
      };
      newActions.push(fallback);
      traces.set(a.ticker, `无 report，防御性 ${a.action} → ${(fallbackTarget * 100).toFixed(1)}%`);
      continue;
    }

    const result = computePosition({
      action: a.action,
      report,
      currentWeight,
      volatility,
      singleNameCap,
      entryPrice: ctx.entryPriceByTicker?.get(a.ticker),
      currentPrice: ctx.currentPriceByTicker?.get(a.ticker),
      daysHeld: ctx.daysHeldByTicker?.get(a.ticker),
      initialStopDrawdown: ctx.constraints.initial_stop_drawdown,
      initialStopDays: ctx.constraints.initial_stop_days,
    });

    // 根据计算结果对齐 action 类型（防 validator 规则 8 误报 + 下游一致性）：
    // - deal_breaker / 建仓回撤止损 强制 target=0 → 改 action 为 SELL
    // - 技术破位强制 REDUCE（trace 含"技术破位"）→ 改 action 为 REDUCE（PM 可能出 HOLD）
    // - REDUCE 小仓位清仓（target=0）→ 改 action 为 SELL（同语义：
    //   target=0 即退出，应记入 recent_sells 防 anti-churn 买锁漏判，execution-planner
    //   也按 SELL 优先级=1 先释放资金）
    // - 其他情况保持 AI 给的方向
    let resolvedAction: ActionType = a.action;
    if (result.targetWeight === 0 && (
      report.deal_breaker
      || a.action === "REDUCE"
      || result.trace.includes("建仓") && result.trace.includes("止损")  // 建仓回撤止损
    )) {
      resolvedAction = "SELL";
    } else if (result.trace.includes("技术破位") && result.targetWeight < currentWeight) {
      resolvedAction = "REDUCE";
    }

    const newAction: Action = {
      ...a,
      action: resolvedAction,
      target_weight: result.targetWeight,
      delta: result.targetWeight - currentWeight,
      // priority 由 action 类型推导（LLM 不再出数字）：
      // SELL=1, REDUCE=2, BUY=3, ADD=4, HOLD=5 —— execution-planner 按此排序
      priority: actionPriority(resolvedAction),
    };
    newActions.push(newAction);
    traces.set(a.ticker, result.trace);
  }

  // 第二遍：现金排队 —— BUY/ADD 按分数降序，现金不够的低分股降级为 HOLD
  // SELL/REDUCE 释放现金：累计到可用池
  const released = newActions
    .filter(a => a.action === "SELL" || a.action === "REDUCE")
    .reduce((s, a) => s + Math.abs(Math.min(0, a.delta)), 0);
  const spendable = Math.max(0, initialCash + released - constraints.cash_reserve);

  const buyAdds = newActions
    .filter(a => (a.action === "BUY" || a.action === "ADD") && a.delta > 0)
    .sort((a, b) => {
      const ra = reportsByTicker.get(a.ticker)?.fitness_score ?? 0;
      const rb = reportsByTicker.get(b.ticker)?.fitness_score ?? 0;
      return rb - ra; // 高分优先
    });

  let spent = 0;
  for (const a of buyAdds) {
    if (spent + a.delta > spendable + 0.0001) {
      // 现金不够：降级为 HOLD（保持当前仓位）
      const oldTrace = traces.get(a.ticker) ?? "";
      traces.set(a.ticker, `${oldTrace} → 现金不足，降级 HOLD`);
      a.action = "HOLD";
      a.target_weight = a.current_weight;
      a.delta = 0;
      a.priority = actionPriority("HOLD");
    } else {
      spent += a.delta;
    }
  }

  // 第三遍：重算 portfolio_after（权重表 + cash）
  const positionsMap = new Map<string, number>();
  for (const a of newActions) {
    if (a.target_weight > 0) {
      positionsMap.set(a.ticker, a.target_weight);
    }
  }
  const totalWeight = Array.from(positionsMap.values()).reduce((s, w) => s + w, 0);
  const cashPct = Math.max(0, 1 - totalWeight);

  const newPlan: RebalancePlan = {
    ...plan,
    actions: newActions,
    portfolio_after: {
      positions: Array.from(positionsMap.entries()).map(([ticker, weight]) => ({ ticker, weight })),
      cash_pct: cashPct,
    },
  };

  return { plan: newPlan, traces };
}

/** 从 reports + volatility 构造 ApplyPositionsContext 的便捷工厂。 */
export function buildApplyContext(
  reports: StockReport[],
  volatilityByTicker: Map<string, number>,
  constraints: RebalanceConstraints,
  initialCash: number,
): ApplyPositionsContext {
  const reportsByTicker = new Map<string, StockReport>();
  for (const r of reports) reportsByTicker.set(r.ticker, r);
  return { reportsByTicker, volatilityByTicker, constraints, initialCash };
}
