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
import { mapIndustryToL1 } from "./industry-map";
import type { MacroView } from "./data-fetcher";
import type { ScanSummary } from "./types";

const REBALANCER_PROMPT_TEMPLATE = `# 角色
你是 A 股趋势跟随策略的组合管理者，管理一个 3-5 只持仓的集中组合（小账户，可接受大回撤）。
基于今日候选 + 当前持仓，输出最优调仓方案。核心目标：**在场抓趋势，技术位止损，不踏空**。

# 任务流程（必须按此顺序思考）
1. 对每只候选/持仓股独立评估：值得入组 / 继续持有 / 应该退出
2. 对每只股给出**方向**（BUY/SELL/ADD/REDUCE/HOLD/SKIP）
3. 自检 anti-churn 锁定（locked 股禁止 SELL/REDUCE）

# ⚠️ 重要：你只决定方向，不决定仓位数字
**不要输出 target_weight / delta / portfolio_after 的数字。**
具体仓位由确定性公式计算（基于 fitness 线性映射 + 波动率折扣），代码会自动填入。
你只需要判断"该买/该卖/该加/该减/该持有/跳过"，把方向和理由写清楚即可。

# 评估框架（每股独立判断，只给方向）

## 候选股（未持仓）
- **fitness ≥4 且 deal_breaker=false**：BUY（仓位随 fitness 线性变化，低分给小仓）
- fitness ≥7 且趋势健康（量价配合/MACD金叉）：BUY（高分给更大仓）
- fitness <4 或 deal_breaker=true：SKIP
- risk=high（技术位破位信号）但不 deal_breaker：可 BUY 小仓试探（靠止损退出，不靠否决）

## 持仓股
- 趋势健康（无见顶信号）+ 非 deal_breaker：HOLD 或 ADD
- **见顶信号**（risk_flags 含 MACD死叉/量价背离/跌破支撑/缩量上涨）：REDUCE 或 SELL（技术位止损）
- deal_breaker=true：SELL（立即清仓）
- locked=true（持仓<{anti_churn_days}天）：仅当 overall_risk=high 或有"高"级 risk_flag 时可止损（SELL/REDUCE），否则只能 HOLD/ADD

# 硬约束（validator 会强制 revise）
- 单仓 ≤ {single_name}
- 单行业 ≤ {single_sector}（按 sector 字段聚合）
- 持仓数 ≤ {max_positions} 只（target_weight>0 的标的数，超了必须 SELL 砍掉，不能只调小仓位）
- 日换手 = max(总买入, 总卖出) ≤ {daily_turnover}（单向算法：只算买卖较大的一边，换仓不被双向累加卡死）
- 现金保留 = 1 - sum(target_weight) ≥ {cash_reserve}
- locked 持仓禁止 SELL/REDUCE，**除非** overall_risk=high 或有"高"级 risk_flag（止损豁免），或浮盈≥{take_profit_threshold_pct}（止盈豁免，落袋为安不是 churn）
- {anti_churn_days} 天内卖出过的 ticker 禁止 BUY

# 软偏好
- 优先 fitness ≥5 的标的（驱动逻辑较强）
- 单日 actions 数量 ≤ 8（趋势模式允许更多调仓动作）
- 同行业新增要谨慎（分散要求）

# 反"老好人"硬规则
- fitness ≤2 的持仓必须 REDUCE 或 SELL（驱动逻辑极弱，不准 HOLD 蒙混）
- actions 不能全是 HOLD，除非：所有持仓 fitness ≥4 + 无见顶信号 + 候选全 deal_breaker 或 fitness<4
- fitness 最高的候选必须出现在 actions 里（BUY/ADD），除非触发 anti-churn 或约束上限
- **集中优先**：候选中有 fitness ≥7 的强标的时，优先重仓少数高分股（3-5 只），
  而非分散买入多只中分股。单仓可到 {single_name}，让确定性高的标的拿大仓位

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

# ⚠️ evaluations 与 actions 的语义分离（revise 时尤其重要）
- **evaluations 是你对每只股的「真实评估」**——基于基本面/趋势/风险，与当日换手、持仓数、行业上限等约束**无关**。
  一只股值不值得买，不会因为"今天额度满了"而变成 SKIP。
- **actions 是「今日实际执行」**——受当日硬约束限制。强标的今天因约束买不进，actions 里不放它，
  但它的 evaluation 仍应是 BUY（理由写真实逻辑，如"订单落地+量价齐升"），而非"额度已满"。
- **revise 修正时只调整 actions**（砍掉超限的 BUY、改成 HOLD 下次再调），
  **不要修改 evaluations 的判断**——不要把约束理由（换手超限/额度已满/持仓已满）写进 brief。
  被 constraints 否决不是你对这只股的真实评价。

注意：
- actions 里**不要**写 current_weight / target_weight / delta / priority（代码会自动算）
- portfolio_after 字段**不要写**（代码会自动重算）
- current_weight 由代码从持仓状态填入，你不需要关心

# 当前持仓
{holdings_json}

# 上次调仓（防反向）
{last_rebalance_json}

# 候选股报告（N 只）
{per_stock_reports}

{macro_section}`;

export function formatRebalancerPrompt(
  reports: StockReport[],
  holdings: Holdings,
  lastRebalance: LastRebalance | null,
  c: RebalanceConstraints,
  antiChurnDays: number,
  macroView?: MacroView | null,
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
    .replace(/\{max_positions\}/g, String(c.max_positions))
    .replace(/\{daily_turnover\}/g, String(c.daily_turnover))
    .replace(/\{cash_reserve\}/g, String(c.cash_reserve))
    .replace(/\{anti_churn_days\}/g, String(antiChurnDays))
    .replace(/\{anti_churn_days_sub\}/g, String(Math.max(antiChurnDays - 1, 0)))
    .replace(/\{take_profit_threshold_pct\}/g, String(Math.round(c.take_profit_threshold * 100)) + "%")
    .replace("{holdings_json}", holdingsStr)
    .replace("{last_rebalance_json}", lastStr)
    .replace("{per_stock_reports}", reportsStr)
    .replace("{macro_section}", renderMacroSection(macroView));
}

/** 把全市场宏观视图渲染成 rebalancer prompt 的一段（组合层上下文）。
 *
 *  宏观与具体股票无关（财新PMI/大宗/NBS/LPR 都是全市场信号），只在组合决策层注入一次。
 *  让 LLM 据此判断："宏观逆风的行业应谨慎加仓 / PMI 共振向上倾向景气制造链 / 大宗
 *  上行利好资源股"——这是组合视角的 beta 判断，单股 shallow-analyzer 看不到。
 *  macroView 为 null/undefined → 空串（该段省略，向后兼容；拉取失败不阻塞）。 */
function renderMacroSection(macroView?: MacroView | null): string {
  if (!macroView) return "";
  const lines: string[] = ["# 今日宏观环境（组合层上下文，影响整体 beta 判断）"];

  // 市场倾向 + PMI 双口径信号
  const parts: string[] = [];
  if (macroView.market_view) parts.push(`市场倾向：${macroView.market_view}`);
  if (macroView.pmi_signal) parts.push(macroView.pmi_signal);
  if (parts.length > 0) lines.push(parts.join("；"));

  // 景气/承压板块（规则引擎推导，让 LLM 判断行业顺/逆风）
  if (macroView.bullish_sectors && macroView.bullish_sectors.length > 0) {
    lines.push(`景气板块：${macroView.bullish_sectors.join("、")}`);
  }
  if (macroView.bearish_sectors && macroView.bearish_sectors.length > 0) {
    lines.push(`承压板块：${macroView.bearish_sectors.join("、")}`);
  }

  // 大宗商品周期锚（金/油/铜）
  if (macroView.commodities) {
    const cm = macroView.commodities;
    const fmt = (sym: string): string => {
      const c = cm[sym];
      if (!c) return "";
      const trend = c.trend ? c.trend : "";
      const chg = typeof c.chg_5d === "number" ? `${c.chg_5d > 0 ? "+" : ""}${c.chg_5d}%` : "";
      const label = c.label || sym;
      return `${label}${trend ? trend : ""}${chg ? `(${chg})` : ""}`;
    };
    const cmParts = ["AU0", "SC0", "CU0"].map(fmt).filter(Boolean);
    if (cmParts.length > 0) lines.push(`大宗：${cmParts.join(" / ")}`);
  }

  if (lines.length <= 1) return "";  // 只有标题行 → 视为无有效数据，省略整段
  lines.push("（参考：宏观逆风的行业应谨慎加仓，PMI 共振向上倾向景气制造链，大宗上行利好资源股）");
  return lines.join("\n");
}

function formatReportLine(r: StockReport): string {
  const flagStr = r.risk_flags.length > 0
    ? r.risk_flags.map(f => `${f.flag}(${f.severity})`).join("; ")
    : "无";
  return [
    `## ${r.ticker} ${r.name} (${r.sector})`,
    `thesis: ${r.thesis}`,
    `fitness: ${r.fitness_score} / risk: ${r.overall_risk}${r.deal_breaker ? " [DEAL_BREAKER]" : ""}`,
    `持仓: ${r.is_held ? `${(r.current_weight * 100).toFixed(1)}%, ${r.days_held}d${r.locked ? " [LOCKED]" : " [UNLOCKED]"}` : "无"}`,
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
  /** ok=校验通过；constraint_violation=至少解析出过 plan 但始终不过校验；
   *  parse_failed=从未解析出合法 plan（全程 JSON 失败，plan=null）；
   *  llm_failed=caller 抛错。区分 parse_failed vs constraint_violation 让事后排查
   *  能判断"是 LLM 没吐对格式"还是"吐对了但满足不了约束"，两者处置不同。 */
  status: "ok" | "constraint_violation" | "parse_failed" | "llm_failed";
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
  /** 候选股报告，供 revise 反馈筛"非超限行业强标的"推荐给 LLM 转向。
   *  候选池偏科时（如电子占 60%），LLM 撞行业上限后不会转向，死磕同行业。
   *  给它具体的非超限行业强标的清单，它才有出路。 */
  reports?: StockReport[],
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

    // 行业超限时，重算超限行业集合，供反馈给出"转向非超限行业强标的"指引。
    // 从失败的 plan + ctx.sectors 重算（比解析 detail 字符串稳健），筛 sum>single_sector 的行业。
    let overSectors: Set<string> | undefined;
    if (result.violations.some(v => v.rule.includes("单行业上限"))) {
      const sums = new Map<string, number>();
      for (const a of parsed.actions) {
        if (a.target_weight <= 0) continue;
        const sec = ctx.sectors.get(a.ticker);
        if (!sec) continue;
        sums.set(sec, (sums.get(sec) ?? 0) + a.target_weight);
      }
      overSectors = new Set([...sums.entries()].filter(([, w]) => w > config.constraints.single_sector + 0.001).map(([s]) => s));
    }
    const feedback = composeReviseFeedback(
      result.violations,
      { overSectors, reports },
    );
    userMessage = basePrompt + "\n\n" + feedback;
    reviseCount++;
  }

  return {
    plan: lastPlan,
    reviseCount,
    // lastPlan===null ⇒ 整轮从未解析出合法 JSON（所有 attempt 都走 parse 失败分支），
    //   与"解析成功但约束不过"是不同的故障，单独标记。
    // lastPlan!==null ⇒ 至少解析成功过，是约束违反（revise 用尽仍不过）。
    status: lastPlan === null ? "parse_failed" : "constraint_violation",
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
  /** 全市场宏观视图（一次性抓取，注入组合决策层）。
   *  null/undefined → rebalancer prompt 省略宏观段（向后兼容）。 */
  macroView?: MacroView | null;
}

export interface RebalancePipelineResult {
  reports: StockReport[];
  rebalancer_output: RebalancePlan;
  constraint_check: { passed: boolean; violations: string[]; revise_count: number };
  execution_plan: ReturnType<typeof buildExecutionPlan>;
  status: "ok" | "constraint_violation" | "parse_failed" | "llm_failed";
  /** 行业拉取相关警告（fundamentals.industry 为空的股按"未分类"累计，规则 3 对它们失效） */
  sector_warnings: string[];
  /** 仓位计算器溯源（ticker → 可读字符串） */
  position_traces: Record<string, string>;
  /** 本次生效的约束配置（DEFAULT + CLI overrides 合并后的最终值）。
   *  写进 planFile.constraints，让 plan.md 的"约束检查"段按真实阈值对比。 */
  constraints: RebalanceConstraints;
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
  const reports = await analyzeAll(metas, dataByTicker, input.shallowCaller, config.shallow_concurrency);

  // 3. 构造 validation context
  //    sectors 来源优先级：fundamentals.industry（全市场口径统一）> report.sector（shallow-analyzer
  //    拿到的，候选股多为"未分类"）> holdings.sector（用户手填，纯持仓股兜底）。
  //    fundamentals.industry 为空（拉取失败）的股标"未分类" + 记 warning（规则 3 对它们失效）。
  //
  //    映射到申万一级：上游 industry 是申万二级（如"半导体"/"PCB"/"军工电子Ⅱ"），若直接按
  //    二级聚合，电子下属 6 个标签会被当成 6 个独立行业 → "假分散"。这里统一映射到一级，
  //    让规则 3 按 31 个一级限制（LLM prompt 里仍展示原始二级细分，不丢失信息）。
  const sectors = new Map<string, string>();
  const sectorMissingTickers: string[] = [];
  const allTickers = new Set<string>([
    ...reports.map(r => r.ticker),
    ...input.holdings.positions.map(p => p.ticker),
  ]);
  for (const ticker of allTickers) {
    const industry = dataByTicker.get(ticker)?.fundamentals.industry ?? "";
    if (industry) {
      sectors.set(ticker, mapIndustryToL1(industry));
    } else {
      // industry 拉取失败：回退 report.sector / holdings.sector，仍为空则标"未分类"
      const report = reports.find(r => r.ticker === ticker);
      const fallback = report?.sector
        ?? input.holdings.positions.find(p => p.ticker === ticker)?.sector
        ?? "未分类";
      const mapped = fallback === "未分类" ? "未分类" : mapIndustryToL1(fallback);
      sectors.set(ticker, mapped);
      if (fallback === "未分类") sectorMissingTickers.push(ticker);
    }
  }
  const sector_warnings: string[] = sectorMissingTickers.length > 0
    ? [`${sectorMissingTickers.length} 只股 industry 拉取失败（${sectorMissingTickers.join(", ")}），规则 3 对它们按"未分类"累计`]
    : [];
  // reportsByTicker 提前构造：held map 需要查 risk 算止损信号
  const reportsByTicker = new Map<string, StockReport>();
  for (const r of reports) reportsByTicker.set(r.ticker, r);

  // held map：locked + stopLossSignal（止损豁免 anti-churn 锁）
  // 止损信号定义（任一即触发，强制退出不是 churn）：
  //   ① overall_risk=high 或有 severity=高 的 risk_flag（技术破位/重大风险）
  //   ② deal_breaker=true（造假/退市/重大违规，强制清仓）
  //   ③ 建仓回撤止损：建仓 ≤initial_stop_days 天内，从 entry_price 回撤 ≥initial_stop_drawdown
  //      （补技术信号盲区：建仓次日大跌但未跌破支撑/量比正常，如国瓷 -8.3% 未破位）
  //   ④ 数据失败的持仓（fallback report）恒真——数据失败即风险，不该被锁住不能动
  //   ①③ 必须在此预判，因为 validator 检查 anti-churn 锁时（revise 内）position-calculator
  //      还没跑，建仓回撤是否触发未知。这里预判 → stopLossSignal=true → 锁放行 → 让
  //      computePosition 真正触发 SELL。
  const entryPriceByPos = new Map<string, number>();
  for (const p of input.holdings.positions) entryPriceByPos.set(p.ticker, p.entry_price);
  const held = new Map<string, { days_held: number; locked: boolean; stopLossSignal?: boolean; takeProfitSignal?: boolean }>();
  for (const m of metas) {
    if (!m.is_held) continue;
    const report = reportsByTicker.get(m.ticker);
    let stopLossSignal: boolean;
    let takeProfitSignal = false;
    if (!report) {
      stopLossSignal = true;  // ④ 数据失败
    } else {
      const entry = entryPriceByPos.get(m.ticker);
      const cur = dataByTicker.get(m.ticker)?.kline.last_close;
      // ③ 建仓回撤预判：建仓 ≤N 天 + 回撤 ≥X%
      const initialStop = Boolean(entry && entry > 0 && cur && cur > 0
        && m.days_held <= config.constraints.initial_stop_days
        && (cur / entry - 1) <= -config.constraints.initial_stop_drawdown);
      stopLossSignal = report.overall_risk === "high"            // ① 技术破位
        || report.risk_flags.some(f => f.severity === "高")
        || report.deal_breaker                                     // ② 致命雷
        || initialStop;                                            // ③ 建仓回撤
      // 止盈豁免：locked 期内浮盈 ≥ 阈值 → 允许突破锁卖出。
      // 与止损镜像：止损防下行（建仓回撤/破位），止盈锁上行（落袋为安）。
      // 阈值默认 15%（take_profit_threshold），低于此视为"还没到止盈点，可能是 churn"。
      takeProfitSignal = Boolean(entry && entry > 0 && cur && cur > 0
        && m.locked
        && (cur / entry - 1) >= config.constraints.take_profit_threshold);
    }
    held.set(m.ticker, { days_held: m.days_held, locked: m.locked, stopLossSignal, takeProfitSignal });
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
  const prompt = formatRebalancerPrompt(reports, input.holdings, input.lastRebalance, config.constraints, config.anti_churn_days, input.macroView);

  // 4a. 构造仓位计算器上下文：波动率 + 当前价（来自 data-fetcher）+ reports + 约束 + 建仓数据
  const volatilityByTicker = new Map<string, number>();
  const currentPriceByTicker = new Map<string, number>();
  for (const [ticker, data] of dataByTicker) {
    volatilityByTicker.set(ticker, data.kline.volatility_20d);
    currentPriceByTicker.set(ticker, data.kline.last_close);
  }
  // 建仓回撤止损所需：entry_price（持仓股）+ days_held（selectCandidates 已算）
  const entryPriceByTicker = new Map<string, number>();
  for (const p of input.holdings.positions) entryPriceByTicker.set(p.ticker, p.entry_price);
  const daysHeldByTicker = new Map<string, number>();
  for (const [ticker, h] of held) daysHeldByTicker.set(ticker, h.days_held);
  const positionCtx: ApplyPositionsContext = {
    reportsByTicker,
    volatilityByTicker,
    constraints: config.constraints,
    initialCash: input.holdings.cash_pct,
    entryPriceByTicker,
    currentPriceByTicker,
    daysHeldByTicker,
  };

  // 4b. 构造 currentWeight 映射（持仓股才有，候选股=0）
  const currentWeights = new Map<string, number>();
  for (const p of input.holdings.positions) currentWeights.set(p.ticker, p.weight);

  const rebalanceResult = await runRebalanceWithRevise(
    input.rebalanceCaller, prompt, ctx, config, positionCtx, currentWeights, reports,
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
      constraints: config.constraints,
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
    constraints: config.constraints,
  };
}
