"use strict";
// src/watchlist/position-calculator.ts
//
// 确定性仓位计算器：把 target_weight 的决定权从 LLM 手里拿走，
// 交给可解释、可复盘的公式。LLM 只决定方向（BUY/SELL/ADD/REDUCE/HOLD），
// 具体数字由公式根据 fitness + 波动率 + 风险等级算出。
//
// 公式主轴：目标仓位 = 基础仓位(fitness查表) × 波动率折扣 × 风险因子
// 再经：现金排队（按分数花钱）+ 单仓上限钳制
Object.defineProperty(exports, "__esModule", { value: true });
exports.actionPriority = actionPriority;
exports.baseWeight = baseWeight;
exports.volatilityFactor = volatilityFactor;
exports.riskFactor = riskFactor;
exports.computePosition = computePosition;
exports.applyPositions = applyPositions;
exports.buildApplyContext = buildApplyContext;
// ── 配置档位（平衡档，可调） ───────────────────────────────────────────────
// ── 配置档位（平衡档，可调） ───────────────────────────────────────────────
/** action 类型 → priority（execution-planner 排序用）。
 *  SELL=1（先释放资金）→ REDUCE=2 → BUY=3 → ADD=4 → HOLD=5（最后）。
 *  与 rebalance-types.ts Action.priority 注释一致。 */
function actionPriority(action) {
    switch (action) {
        case "SELL": return 1;
        case "REDUCE": return 2;
        case "BUY": return 3;
        case "ADD": return 4;
        case "HOLD": return 5;
    }
}
/** fitness 分数 → 基础仓位（折扣前）。
 *  平衡档：9分→7% / 8分→5% / 7分→3% / ≤6→0%（不买）。
 *  线性插值：8.5分 = 6%（5% + 2% × 0.5）。 */
function baseWeight(fitness) {
    if (fitness >= 9)
        return 0.07;
    if (fitness >= 8)
        return 0.05 + (fitness - 8) * 0.02; // 8→5%, 8.5→6%, 8.99→6.98%
    if (fitness >= 7)
        return 0.03 + (fitness - 7) * 0.02; // 7→3%, 7.5→4%
    return 0; // ≤6 不买
}
/** 波动率折扣：日线收益率标准差（单位 0-1，如 0.025 = 2.5%/日）。
 *  <2%/日 ×1.0（大盘股），2-4% ×0.8（成长股），>4% ×0.6（题材/次新）。 */
function volatilityFactor(volatility) {
    if (volatility < 0.02)
        return 1.0;
    if (volatility < 0.04)
        return 0.8;
    return 0.6;
}
/** 风险因子：low ×1.0，medium ×0.6，high ×0.3。
 *  deal_breaker 不在这里返回，由上层强制改 action 为 SELL。 */
function riskFactor(overallRisk) {
    switch (overallRisk) {
        case "low": return 1.0;
        case "medium": return 0.6;
        case "high": return 0.3;
    }
}
/** 算出单只股票的目标仓位。
 *  纯函数，无副作用，可独立测试。 */
function computePosition(input) {
    const { action, report, currentWeight, volatility, singleNameCap } = input;
    // SELL：清仓（最高优先级，deal_breaker 也走这里）
    if (action === "SELL") {
        return { targetWeight: 0, trace: "SELL：清仓至 0%" };
    }
    // deal_breaker：无论 AI 给什么方向（除已 SELL 外），强制 SELL（防 AI 漏判致命雷）
    if (report.deal_breaker) {
        return { targetWeight: 0, trace: `deal_breaker 强制清仓（AI 出 ${action}，致命雷覆盖）` };
    }
    // HOLD：不动，保持当前仓位（deal_breaker 已在上一步拦截）
    if (action === "HOLD") {
        return { targetWeight: currentWeight, trace: `HOLD：维持当前 ${(currentWeight * 100).toFixed(1)}%` };
    }
    // REDUCE：减半（fitness≤5 或 high risk 触发，代码不信任 AI 的具体数字）
    if (action === "REDUCE") {
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
    // BUY：基础仓位 × 波动率折扣 × 风险因子
    const base = baseWeight(report.fitness_score);
    if (base === 0) {
        // fitness≤6：BUY 不应该发生（prompt 要求 AI 跳过），防御性返回 0
        return { targetWeight: 0, trace: `fitness ${report.fitness_score} ≤6，BUY 不生效（应为 SKIP）` };
    }
    const volF = volatilityFactor(volatility);
    const riskF = riskFactor(report.overall_risk);
    const raw = base * volF * riskF;
    const capped = Math.min(raw, singleNameCap);
    return {
        targetWeight: capped,
        trace: `BUY：${report.fitness_score}分基础 ${(base * 100).toFixed(1)}% × 波动率${volF}(${(volatility * 100).toFixed(1)}%) × 风险${riskF}(${report.overall_risk}) = ${(capped * 100).toFixed(2)}%`,
    };
}
/** 改写 plan 的所有 actions：把 LLM 给的 target_weight/delta 替换为公式算出的值。
 *  同时重算 portfolio_after 和 cash_pct，保证 validator 规则 1（权重和=1）通过。
 *
 *  返回新 plan（不改原对象）+ 每只股的计算溯源（便于审计/复盘）。 */
function applyPositions(plan, ctx) {
    const { reportsByTicker, volatilityByTicker, constraints, initialCash } = ctx;
    const singleNameCap = constraints.single_name;
    // 第一遍：算出每个 action 的目标仓位（不含现金排队）
    const newActions = [];
    const traces = new Map();
    for (const a of plan.actions) {
        const report = reportsByTicker.get(a.ticker);
        const currentWeight = a.current_weight;
        const volatility = volatilityByTicker.get(a.ticker) ?? 0;
        if (!report) {
            // 无报告的 action（理论不该发生，防御性）：HOLD 保持当前，其他清零
            const fallbackTarget = a.action === "HOLD" ? currentWeight : 0;
            const fallback = {
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
        });
        // 根据计算结果对齐 action 类型（防 validator 规则 8 误报）：
        // - deal_breaker 强制 target=0 → 改 action 为 SELL
        // - 其他情况保持 AI 给的方向
        let resolvedAction = a.action;
        if (report.deal_breaker && result.targetWeight === 0) {
            resolvedAction = "SELL";
        }
        const newAction = {
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
        }
        else {
            spent += a.delta;
        }
    }
    // 第三遍：重算 portfolio_after（权重表 + cash）
    const positionsMap = new Map();
    for (const a of newActions) {
        if (a.target_weight > 0) {
            positionsMap.set(a.ticker, a.target_weight);
        }
    }
    const totalWeight = Array.from(positionsMap.values()).reduce((s, w) => s + w, 0);
    const cashPct = Math.max(0, 1 - totalWeight);
    const newPlan = {
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
function buildApplyContext(reports, volatilityByTicker, constraints, initialCash) {
    const reportsByTicker = new Map();
    for (const r of reports)
        reportsByTicker.set(r.ticker, r);
    return { reportsByTicker, volatilityByTicker, constraints, initialCash };
}
//# sourceMappingURL=position-calculator.js.map