import type {
  Action, ActionType, Evaluation, Holdings, LastRebalance,
  PortfolioAfter, RebalanceConstraints, RebalancePlan, StockReport,
  ConstraintViolation, RebalanceConfig,
} from "./rebalance-types";
import { DEFAULT_REBALANCE_CONFIG } from "./rebalance-types";
import { validateRebalance, composeReviseFeedback, type ValidationContext } from "./constraint-validator";
import { selectCandidates } from "./candidate-selector";
import { analyzeAll, type ShallowLlmCaller, type StockData } from "./shallow-analyzer";
import { buildExecutionPlan } from "./execution-planner";
import { applyPositions, type ApplyPositionsContext } from "./position-calculator";
import type { ScanSummary } from "./types";

const REBALANCER_PROMPT_TEMPLATE = `# 角色
你是 A 股投资组合管理者，管理一个 5-10 只持仓的中等换手组合。
基于今日候选 + 当前持仓，输出最优调仓方案。

# 任务流程（必须按此顺序思考）
1. 对每只候选/持仓股独立评估：值得入组 / 继续持有 / 应该退出
2. 对每只股给出**方向**（BUY/SELL/ADD/REDUCE/HOLD/SKIP）
3. 自检 anti-churn 锁定（locked 股禁止 SELL/REDUCE）

# ⚠️ 重要：你只决定方向，不决定仓位数字
**不要输出 target_weight / delta / portfolio_after 的数字。**
具体仓位由确定性公式计算（基于 fitness、波动率、风险等级），代码会自动填入。
你只需要判断"该买/该卖/该加/该减/该持有/跳过"，把方向和理由写清楚即可。

# 评估框架（每股独立判断，只给方向）

## 候选股（未持仓）
- fitness ≥8 且 risk=low：BUY
- fitness ≥8 且 risk=medium：BUY 或 SKIP（看驱动逻辑是否硬）
- fitness 6-7：SKIP
- fitness ≤5 或 deal_breaker=true：SKIP

## 持仓股
- fitness ≥8 且 risk=low：HOLD 或 ADD
- fitness 6-7 且 risk 可控：HOLD（默认）
- fitness ≤5 或 risk=high 或 deal_breaker=true：REDUCE 或 SELL
- locked=true（持仓<{anti_churn_days}天）：只能 HOLD 或 ADD，禁止 SELL/REDUCE

# 硬约束（validator 会强制 revise）
- 单仓 ≤ {single_name}
- 单行业 ≤ {single_sector}（按 sector 字段聚合）
- 日换手 = sum(|delta|) ≤ {daily_turnover}
- 现金保留 = 1 - sum(target_weight) ≥ {cash_reserve}
- {anti_churn_days} 天内买入的 locked 股禁止 SELL/REDUCE
- {anti_churn_days} 天内卖出过的 ticker 禁止 BUY

# 软偏好
- 优先 fitness ≥7 的标的
- 单日 actions 数量 ≤ 5
- 同行业新增要谨慎

# 反"老好人"硬规则
- fitness ≤5 的持仓必须 REDUCE 或 SELL（不准 HOLD 蒙混）
- actions 不能全是 HOLD，除非：所有持仓 fitness ≥7 + 所有候选 fitness <6 + 无 deal_breaker
- fitness 最高的候选必须出现在 actions 里（BUY/ADD），除非触发 anti-churn 或约束上限

# reason 写作规则（严格）
- 必须含至少 1 个具体词（产品/客户/数据/业务节点）
- 禁止模糊词（共振/资金追捧/活跃/爆发力强...）

# 输出格式（严格 JSON，只含方向和理由，不含数字）
{
  "evaluations": [
    { "ticker": "...", "judgment": "BUY|HOLD|REDUCE|SELL|SKIP", "brief": "1 句评估" }
  ],
  "actions": [
    {
      "action": "BUY" | "SELL" | "ADD" | "REDUCE" | "HOLD",
      "ticker": "...",
      "name": "...",
      "reason": "..."
    }
  ],
  "summary": "一句话总结今日调仓逻辑"
}

注意：
- actions 里**不要**写 current_weight / target_weight / delta / priority（代码会自动算）
- portfolio_after 字段**不要写**（代码会自动重算）
- current_weight 由代码从持仓状态填入，你不需要关心

# 当前持仓
{holdings_json}

# 上次调仓（防反向）
{last_rebalance_json}

# 候选股报告（N 只）
{per_stock_reports}`;

export function formatRebalancerPrompt(
  reports: StockReport[],
  holdings: Holdings,
  lastRebalance: LastRebalance | null,
  c: RebalanceConstraints,
  antiChurnDays: number,
): string {
  const holdingsStr = JSON.stringify({
    cash_pct: holdings.cash_pct,
    positions: holdings.positions.map(p => ({
      ticker: p.ticker, name: p.name, sector: p.sector,
      weight: p.weight,
    })),
  }, null, 2);
  const lastStr = lastRebalance ? JSON.stringify(lastRebalance, null, 2) : "(首次运行，无 last_rebalance)";
  const reportsStr = reports.map(r => formatReportLine(r)).join("\n\n");

  return REBALANCER_PROMPT_TEMPLATE
    .replace(/\{single_name\}/g, String(c.single_name))
    .replace(/\{single_sector\}/g, String(c.single_sector))
    .replace(/\{daily_turnover\}/g, String(c.daily_turnover))
    .replace(/\{cash_reserve\}/g, String(c.cash_reserve))
    .replace(/\{anti_churn_days\}/g, String(antiChurnDays))
    .replace("{holdings_json}", holdingsStr)
    .replace("{last_rebalance_json}", lastStr)
    .replace("{per_stock_reports}", reportsStr);
}

function formatReportLine(r: StockReport): string {
  const flagStr = r.risk_flags.length > 0
    ? r.risk_flags.map(f => `${f.flag}(${f.severity})`).join("; ")
    : "无";
  return [
    `## ${r.ticker} ${r.name} (${r.sector})`,
    `thesis: ${r.thesis}`,
    `fitness: ${r.fitness_score} / risk: ${r.overall_risk}${r.deal_breaker ? " [DEAL_BREAKER]" : ""}`,
    `持仓: ${r.is_held ? `${(r.current_weight * 100).toFixed(1)}%, ${r.days_held}d${r.locked ? " [LOCKED]" : ""}` : "无"}`,
    `风险: ${flagStr}`,
    `关键信号: ${r.key_signals.join("; ") || "无"}`,
    r.ranker_score !== undefined ? `ranker_score: ${r.ranker_score}` : "",
    // 质量门控标注：让 rebalancer LLM 知道 fitness 被代码钳制过（避免困惑/二次质疑）。
    // 与 position_traces 的溯源精神一致——可解释性贯穿全链路。
    r.quality_notes && r.quality_notes.length > 0 ? `质量门控: ${r.quality_notes.join("; ")}` : "",
  ].filter(Boolean).join("\n");
}

/** 解析 rebalancer 输出。过滤幻觉 ticker。失败返回 null。 */
export function parseRebalancePlan(content: string, validTickers: Set<string>): RebalancePlan | null {
  const obj = extractJson(content);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.actions) || !Array.isArray(o.evaluations)) return null;

  const actions: Action[] = (o.actions as unknown[])
    .filter((x): x is Record<string, unknown> =>
      !!x && typeof x === "object" &&
      typeof (x as any).ticker === "string" && validTickers.has((x as any).ticker))
    .map(x => {
      const a = x as any;
      return {
        action: (["BUY", "SELL", "ADD", "REDUCE", "HOLD"].includes(a.action) ? a.action : "HOLD") as ActionType,
        ticker: a.ticker as string,
        name: typeof a.name === "string" ? a.name : "",
        current_weight: typeof a.current_weight === "number" ? a.current_weight : 0,
        target_weight: typeof a.target_weight === "number" ? a.target_weight : 0,
        delta: typeof a.delta === "number" ? a.delta : 0,
        reason: typeof a.reason === "string" ? a.reason : "",
        priority: typeof a.priority === "number" ? a.priority : 5,
      };
    });

  const evaluations: Evaluation[] = (o.evaluations as unknown[])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map(x => {
      const e = x as any;
      return {
        ticker: typeof e.ticker === "string" ? e.ticker : "",
        judgment: (["BUY", "HOLD", "REDUCE", "SELL", "SKIP"].includes(e.judgment) ? e.judgment : "SKIP") as Evaluation["judgment"],
        brief: typeof e.brief === "string" ? e.brief : "",
      };
    });

  const pa = (o.portfolio_after ?? {}) as any;
  const portfolio_after: PortfolioAfter = {
    positions: Array.isArray(pa.positions) ? pa.positions : [],
    cash_pct: typeof pa.cash_pct === "number" ? pa.cash_pct : 0,
  };

  return {
    evaluations,
    actions,
    portfolio_after,
    summary: typeof o.summary === "string" ? o.summary : "",
  };
}

function extractJson(content: string): unknown | null {
  if (!content) return null;
  const codeBlock = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch { /* fall through */ }
  }
  const start = content.indexOf("{");
  if (start === -1) return null;
  let depth = 0, endIdx = -1, inStr = false, escape = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  if (endIdx === -1) return null;
  try { return JSON.parse(content.slice(start, endIdx + 1)); } catch { return null; }
}

export type RebalanceLlmCaller = (input: {
  systemPrompt: string;
  userMessage: string;
}) => Promise<string>;

export interface RebalanceResult {
  plan: RebalancePlan | null;
  reviseCount: number;
  status: "ok" | "constraint_violation" | "llm_failed";
  finalViolations: ConstraintViolation[];
  positionTraces: Map<string, string>;
}

/** 跑 rebalancer + revise loop。最多 max_revise_retries 次。
 *
 *  positionCtx 可选：传入后每次 parse 出的 plan 会先经 applyPositions 改写
 *  （LLM 只出方向，代码算仓位），再 validate。这是确定性仓位计算器的接入点。 */
export async function runRebalanceWithRevise(
  caller: RebalanceLlmCaller,
  basePrompt: string,
  ctx: ValidationContext,
  config: RebalanceConfig,
  positionCtx?: ApplyPositionsContext,
  /** ticker → 当前仓位（持仓股才有，候选股=0）。
   *  用于 parse 后补齐 current_weight（LLM 不再输出这个字段）。 */
  currentWeights?: Map<string, number>,
): Promise<RebalanceResult> {
  let userMessage = basePrompt;
  let lastPlan: RebalancePlan | null = null;
  let lastViolations: ConstraintViolation[] = [];
  let reviseCount = 0;
  let lastTraces = new Map<string, string>();

  for (let attempt = 0; attempt <= config.max_revise_retries; attempt++) {
    let content: string;
    try {
      content = await caller({ systemPrompt: "", userMessage });
    } catch {
      return { plan: lastPlan, reviseCount, status: "llm_failed", finalViolations: lastViolations, positionTraces: lastTraces };
    }

    let parsed = parseRebalancePlan(content, ctx.tickersInPool);
    if (!parsed) {
      // JSON 解析失败，再试一次（算 revise）
      userMessage = basePrompt + "\n\n上一次输出不是合法 JSON，请严格按格式输出。";
      reviseCount++;
      continue;
    }

    // 补齐 current_weight（LLM 不再输出，从持仓状态取）
    if (currentWeights) {
      for (const a of parsed.actions) {
        if (currentWeights.has(a.ticker)) {
          a.current_weight = currentWeights.get(a.ticker)!;
        }
      }
    }

    // 应用确定性仓位计算器（LLM 出方向，代码算数字）
    if (positionCtx) {
      const applied = applyPositions(parsed, positionCtx);
      parsed = applied.plan;
      lastTraces = applied.traces;
    }

    lastPlan = parsed;

    const result = validateRebalance(parsed, ctx, config.constraints);
    if (result.passed) {
      return { plan: lastPlan, reviseCount, status: "ok", finalViolations: [], positionTraces: lastTraces };
    }
    lastViolations = result.violations;
    if (attempt >= config.max_revise_retries) break;

    const feedback = composeReviseFeedback(result.violations);
    userMessage = basePrompt + "\n\n" + feedback;
    reviseCount++;
  }

  return {
    plan: lastPlan,
    reviseCount,
    status: "constraint_violation",
    finalViolations: lastViolations,
    positionTraces: lastTraces,
  };
}

export interface RebalancePipelineInput {
  scan: ScanSummary;
  holdings: Holdings;
  lastRebalance: LastRebalance | null;
  currentDate: string;
  shallowCaller: ShallowLlmCaller;
  rebalanceCaller: RebalanceLlmCaller;
  dataByTicker?: Map<string, StockData>;
  config?: Partial<RebalanceConfig>;
}

export interface RebalancePipelineResult {
  reports: StockReport[];
  rebalancer_output: RebalancePlan;
  constraint_check: { passed: boolean; violations: string[]; revise_count: number };
  execution_plan: ReturnType<typeof buildExecutionPlan>;
  status: "ok" | "constraint_violation" | "llm_failed";
  /** 行业拉取相关警告（fundamentals.industry 为空的股按"未分类"累计，规则 3 对它们失效） */
  sector_warnings: string[];
  /** 仓位计算器溯源（ticker → 可读字符串） */
  position_traces: Record<string, string>;
}

/** 完整 pipeline：候选选择 → shallow-analyzer → rebalancer + revise → execution plan。 */
export async function rebalancePipeline(input: RebalancePipelineInput): Promise<RebalancePipelineResult> {
  const config: RebalanceConfig = { ...DEFAULT_REBALANCE_CONFIG, ...input.config };

  // 1. 候选选择
  const metas = selectCandidates(input.scan, input.holdings, {
    topN: config.top_n,
    currentDate: input.currentDate,
    antiChurnDays: config.anti_churn_days,
  });

  // 2. shallow-analyzer（dataByTicker 由 CLI 注入；测试可直接传）
  const dataByTicker = input.dataByTicker ?? new Map<string, StockData>();
  const reports = await analyzeAll(metas, dataByTicker, input.shallowCaller);

  // 3. 构造 validation context
  //    sectors 来源优先级：fundamentals.industry（全市场口径统一）> report.sector（shallow-analyzer
  //    拿到的，候选股多为"未分类"）> holdings.sector（用户手填，纯持仓股兜底）。
  //    fundamentals.industry 为空（拉取失败）的股标"未分类" + 记 warning（规则 3 对它们失效）。
  const sectors = new Map<string, string>();
  const sectorMissingTickers: string[] = [];
  const allTickers = new Set<string>([
    ...reports.map(r => r.ticker),
    ...input.holdings.positions.map(p => p.ticker),
  ]);
  for (const ticker of allTickers) {
    const industry = dataByTicker.get(ticker)?.fundamentals.industry ?? "";
    if (industry) {
      sectors.set(ticker, industry);
    } else {
      // industry 拉取失败：回退 report.sector / holdings.sector，仍为空则标"未分类"
      const report = reports.find(r => r.ticker === ticker);
      const fallback = report?.sector
        ?? input.holdings.positions.find(p => p.ticker === ticker)?.sector
        ?? "未分类";
      sectors.set(ticker, fallback === "未分类" ? "未分类" : fallback);
      if (fallback === "未分类") sectorMissingTickers.push(ticker);
    }
  }
  const sector_warnings: string[] = sectorMissingTickers.length > 0
    ? [`${sectorMissingTickers.length} 只股 industry 拉取失败（${sectorMissingTickers.join(", ")}），规则 3 对它们按"未分类"累计`]
    : [];
  const held = new Map<string, { days_held: number; locked: boolean }>();
  for (const m of metas) {
    if (m.is_held) held.set(m.ticker, { days_held: m.days_held, locked: m.locked });
  }
  // anti-churn 买锁：最近 N 天内卖出过的 ticker 禁止 BUY
  // 优先用 recent_sells（跨次累积，覆盖多次 rebalance），fallback 到 lastRebalance.actions
  const recentSold = new Set<string>();
  const currentMs = new Date(input.currentDate + "T00:00:00+08:00").getTime();
  if (input.lastRebalance?.recent_sells) {
    for (const [tick, sellDate] of Object.entries(input.lastRebalance.recent_sells)) {
      const sellMs = new Date(sellDate + "T00:00:00+08:00").getTime();
      if (Math.floor((currentMs - sellMs) / 86_400_000) < config.anti_churn_days) {
        recentSold.add(tick);
      }
    }
  } else if (input.lastRebalance) {
    // 旧版 last_rebalance.json 无 recent_sells：fallback 到单次检查
    const daysSince = Math.floor((currentMs -
      new Date(input.lastRebalance.date + "T00:00:00+08:00").getTime()) / 86_400_000);
    if (daysSince < config.anti_churn_days) {
      for (const ac of input.lastRebalance.actions) {
        if (ac.action === "SELL") recentSold.add(ac.ticker);
      }
    }
  }
  const fitnessByTicker = new Map<string, number>();
  for (const r of reports) fitnessByTicker.set(r.ticker, r.fitness_score);
  const ctx: ValidationContext = {
    sectors, held,
    tickersInPool: new Set(reports.map(r => r.ticker)),
    recentSoldTickers: recentSold,
    fitnessByTicker,
  };

  // 4. rebalancer + revise（接入确定性仓位计算器）
  const prompt = formatRebalancerPrompt(reports, input.holdings, input.lastRebalance, config.constraints, config.anti_churn_days);

  // 4a. 构造仓位计算器上下文：波动率（来自 data-fetcher）+ reports + 约束
  const volatilityByTicker = new Map<string, number>();
  for (const [ticker, data] of dataByTicker) {
    volatilityByTicker.set(ticker, data.kline.volatility_20d);
  }
  const reportsByTicker = new Map<string, StockReport>();
  for (const r of reports) reportsByTicker.set(r.ticker, r);
  const positionCtx: ApplyPositionsContext = {
    reportsByTicker,
    volatilityByTicker,
    constraints: config.constraints,
    initialCash: input.holdings.cash_pct,
  };

  // 4b. 构造 currentWeight 映射（持仓股才有，候选股=0）
  const currentWeights = new Map<string, number>();
  for (const p of input.holdings.positions) currentWeights.set(p.ticker, p.weight);

  const rebalanceResult = await runRebalanceWithRevise(
    input.rebalanceCaller, prompt, ctx, config, positionCtx, currentWeights,
  );

  if (!rebalanceResult.plan) {
    return {
      reports,
      rebalancer_output: { evaluations: [], actions: [], portfolio_after: { positions: [], cash_pct: 0 }, summary: "(LLM failed)" },
      constraint_check: { passed: false, violations: [], revise_count: rebalanceResult.reviseCount },
      execution_plan: { execution_sequence: [], final_state: { positions: [], cash_pct: 0 }, warnings: ["LLM failed"] },
      status: rebalanceResult.status,
      sector_warnings,
      position_traces: Object.fromEntries(rebalanceResult.positionTraces),
    };
  }

  // 5. execution plan
  const execution_plan = buildExecutionPlan(rebalanceResult.plan, input.holdings.cash_pct);

  return {
    reports,
    rebalancer_output: rebalanceResult.plan,
    constraint_check: {
      passed: rebalanceResult.status === "ok",
      violations: rebalanceResult.finalViolations.map(v => `[${v.rule}] ${v.detail}`),
      revise_count: rebalanceResult.reviseCount,
    },
    execution_plan,
    status: rebalanceResult.status,
    sector_warnings,
    position_traces: Object.fromEntries(rebalanceResult.positionTraces),
  };
}
