"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatRebalancerPrompt = formatRebalancerPrompt;
exports.parseRebalancePlan = parseRebalancePlan;
exports.runRebalanceWithRevise = runRebalanceWithRevise;
exports.rebalancePipeline = rebalancePipeline;
const rebalance_types_1 = require("./rebalance-types");
const constraint_validator_1 = require("./constraint-validator");
const candidate_selector_1 = require("./candidate-selector");
const shallow_analyzer_1 = require("./shallow-analyzer");
const execution_planner_1 = require("./execution-planner");
const REBALANCER_PROMPT_TEMPLATE = `# 角色
你是 A 股投资组合管理者，管理一个 5-10 只持仓的中等换手组合。
基于今日候选 + 当前持仓，输出最优调仓方案。

# 任务流程（必须按此顺序思考）
1. 对每只候选/持仓股独立评估：值得入组 / 继续持有 / 应该退出
2. 在硬约束下选择最优组合配置
3. 排序 actions（SELL 优先释放资金，BUY/ADD 用释放的资金）
4. 自检约束 + 自检 anti-churn 锁定

# 评估框架（每股独立判断）

## 候选股（未持仓）
- fitness ≥8 且 risk=low：BUY（target_weight 5-10%）
- fitness ≥8 且 risk=medium：BUY（target_weight ≤5%）或跳过
- fitness 6-7：跳过
- fitness ≤5 或 deal_breaker=true：跳过

## 持仓股
- fitness ≥8 且 risk=low：HOLD 或 ADD（小幅加 2-3%）
- fitness 6-7 且 risk 可控：HOLD（默认）
- fitness ≤5 或 risk=high 或 deal_breaker=true：REDUCE（减半）或 SELL（清仓）
- locked=true（持仓<{anti_churn_days}天）：只能 HOLD 或 ADD，禁止 SELL/REDUCE

# 硬约束（违反则方案作废，validator 会强制 revise）
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
- fitness ≤5 的持仓必须 REDUCE 或 SELL
- actions 不能全是 HOLD，除非：所有持仓 fitness ≥7 + 所有候选 fitness <6 + 无 deal_breaker
- fitness 最高的候选必须出现在 actions 里（BUY/ADD），除非触发 anti-churn 或约束上限

# reason 写作规则（严格）
- 必须含至少 1 个具体词（产品/客户/数据/业务节点）
- 禁止模糊词（共振/资金追捧/活跃/爆发力强...）

# 输出格式（严格 JSON）
{
  "evaluations": [
    { "ticker": "...", "judgment": "BUY|HOLD|REDUCE|SELL|SKIP", "brief": "1 句评估" }
  ],
  "actions": [
    {
      "action": "BUY" | "SELL" | "ADD" | "REDUCE" | "HOLD",
      "ticker": "...", "name": "...",
      "current_weight": 0.0, "target_weight": 0.0, "delta": -0.10,
      "reason": "...", "priority": 1
    }
  ],
  "portfolio_after": {
    "positions": [{"ticker": "...", "weight": 0.0}],
    "cash_pct": 0.0
  },
  "summary": "一句话总结"
}

# 当前持仓
{holdings_json}

# 上次调仓（防反向）
{last_rebalance_json}

# 候选股报告（N 只）
{per_stock_reports}`;
function formatRebalancerPrompt(reports, holdings, lastRebalance, c, antiChurnDays) {
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
function formatReportLine(r) {
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
    ].filter(Boolean).join("\n");
}
/** 解析 rebalancer 输出。过滤幻觉 ticker。失败返回 null。 */
function parseRebalancePlan(content, validTickers) {
    const obj = extractJson(content);
    if (!obj || typeof obj !== "object")
        return null;
    const o = obj;
    if (!Array.isArray(o.actions) || !Array.isArray(o.evaluations))
        return null;
    const actions = o.actions
        .filter((x) => !!x && typeof x === "object" &&
        typeof x.ticker === "string" && validTickers.has(x.ticker))
        .map(x => {
        const a = x;
        return {
            action: (["BUY", "SELL", "ADD", "REDUCE", "HOLD"].includes(a.action) ? a.action : "HOLD"),
            ticker: a.ticker,
            name: typeof a.name === "string" ? a.name : "",
            current_weight: typeof a.current_weight === "number" ? a.current_weight : 0,
            target_weight: typeof a.target_weight === "number" ? a.target_weight : 0,
            delta: typeof a.delta === "number" ? a.delta : 0,
            reason: typeof a.reason === "string" ? a.reason : "",
            priority: typeof a.priority === "number" ? a.priority : 5,
        };
    });
    const evaluations = o.evaluations
        .filter((x) => !!x && typeof x === "object")
        .map(x => {
        const e = x;
        return {
            ticker: typeof e.ticker === "string" ? e.ticker : "",
            judgment: (["BUY", "HOLD", "REDUCE", "SELL", "SKIP"].includes(e.judgment) ? e.judgment : "SKIP"),
            brief: typeof e.brief === "string" ? e.brief : "",
        };
    });
    const pa = (o.portfolio_after ?? {});
    const portfolio_after = {
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
function extractJson(content) {
    if (!content)
        return null;
    const codeBlock = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) {
        try {
            return JSON.parse(codeBlock[1].trim());
        }
        catch { /* fall through */ }
    }
    const start = content.indexOf("{");
    if (start === -1)
        return null;
    let depth = 0, endIdx = -1, inStr = false, escape = false;
    for (let i = start; i < content.length; i++) {
        const ch = content[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (ch === "\\") {
            escape = true;
            continue;
        }
        if (ch === '"') {
            inStr = !inStr;
            continue;
        }
        if (inStr)
            continue;
        if (ch === "{")
            depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) {
                endIdx = i;
                break;
            }
        }
    }
    if (endIdx === -1)
        return null;
    try {
        return JSON.parse(content.slice(start, endIdx + 1));
    }
    catch {
        return null;
    }
}
/** 跑 rebalancer + revise loop。最多 max_revise_retries 次。 */
async function runRebalanceWithRevise(caller, basePrompt, ctx, config) {
    let userMessage = basePrompt;
    let lastPlan = null;
    let lastViolations = [];
    let reviseCount = 0;
    for (let attempt = 0; attempt <= config.max_revise_retries; attempt++) {
        let content;
        try {
            content = await caller({ systemPrompt: "", userMessage });
        }
        catch {
            return { plan: lastPlan, reviseCount, status: "llm_failed", finalViolations: lastViolations };
        }
        lastPlan = parseRebalancePlan(content, ctx.tickersInPool);
        if (!lastPlan) {
            // JSON 解析失败，再试一次（算 revise）
            userMessage = basePrompt + "\n\n上一次输出不是合法 JSON，请严格按格式输出。";
            reviseCount++;
            continue;
        }
        const result = (0, constraint_validator_1.validateRebalance)(lastPlan, ctx, config.constraints);
        if (result.passed) {
            return { plan: lastPlan, reviseCount, status: "ok", finalViolations: [] };
        }
        lastViolations = result.violations;
        if (attempt >= config.max_revise_retries)
            break;
        const feedback = (0, constraint_validator_1.composeReviseFeedback)(result.violations);
        userMessage = basePrompt + "\n\n" + feedback;
        reviseCount++;
    }
    return {
        plan: lastPlan,
        reviseCount,
        status: "constraint_violation",
        finalViolations: lastViolations,
    };
}
/** 完整 pipeline：候选选择 → shallow-analyzer → rebalancer + revise → execution plan。 */
async function rebalancePipeline(input) {
    const config = { ...rebalance_types_1.DEFAULT_REBALANCE_CONFIG, ...input.config };
    // 1. 候选选择
    const metas = (0, candidate_selector_1.selectCandidates)(input.scan, input.holdings, {
        topN: config.top_n,
        currentDate: input.currentDate,
        antiChurnDays: config.anti_churn_days,
    });
    // 2. shallow-analyzer（dataByTicker 由 CLI 注入；测试可直接传）
    const dataByTicker = input.dataByTicker ?? new Map();
    const reports = await (0, shallow_analyzer_1.analyzeAll)(metas, dataByTicker, input.shallowCaller);
    // 3. 构造 validation context
    const sectors = new Map();
    for (const r of reports)
        sectors.set(r.ticker, r.sector);
    for (const p of input.holdings.positions) {
        if (!sectors.has(p.ticker))
            sectors.set(p.ticker, p.sector);
    }
    const held = new Map();
    for (const m of metas) {
        if (m.is_held)
            held.set(m.ticker, { days_held: m.days_held, locked: m.locked });
    }
    const recentSold = new Set();
    if (input.lastRebalance) {
        const daysSince = Math.floor((new Date(input.currentDate + "T00:00:00+08:00").getTime() -
            new Date(input.lastRebalance.date + "T00:00:00+08:00").getTime()) / (24 * 60 * 60 * 1000));
        if (daysSince < config.anti_churn_days) {
            for (const ac of input.lastRebalance.actions) {
                if (ac.action === "SELL")
                    recentSold.add(ac.ticker);
            }
        }
    }
    const ctx = {
        sectors, held,
        tickersInPool: new Set(reports.map(r => r.ticker)),
        recentSoldTickers: recentSold,
    };
    // 4. rebalancer + revise
    const prompt = formatRebalancerPrompt(reports, input.holdings, input.lastRebalance, config.constraints, config.anti_churn_days);
    const rebalanceResult = await runRebalanceWithRevise(input.rebalanceCaller, prompt, ctx, config);
    if (!rebalanceResult.plan) {
        return {
            reports,
            rebalancer_output: { evaluations: [], actions: [], portfolio_after: { positions: [], cash_pct: 0 }, summary: "(LLM failed)" },
            constraint_check: { passed: false, violations: [], revise_count: rebalanceResult.reviseCount },
            execution_plan: { execution_sequence: [], final_state: { positions: [], cash_pct: 0 }, warnings: ["LLM failed"] },
            status: rebalanceResult.status,
        };
    }
    // 5. execution plan
    const execution_plan = (0, execution_planner_1.buildExecutionPlan)(rebalanceResult.plan, input.holdings.cash_pct);
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
    };
}
//# sourceMappingURL=rebalancer.js.map