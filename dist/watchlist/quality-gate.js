"use strict";
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
// 7 条规则分两类：
// - 钳制型（1-4, 7）：有明确 prompt 数据依据，代码直接改值兜底
// - 标注型（5-6）：语义模糊无法自修，只记 issue 留给 rebalancer LLM / 人看
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyQualityGate = applyQualityGate;
/** fitness 在无法证实业绩 / 数据缺失 / 传闻时的封顶值。
 *  精确对齐下游 position-calculator.baseWeight：≤6 → 基础仓位 0%（BUY 路径切断），
 *  且对齐 prompt 评分原则原话（"数据缺失...不超过 6"、"传闻...最多 6 分"）。 */
const FITNESS_UNVERIFIABLE_CAP = 6;
/** 传闻/未证实类关键词（对齐 prompt：「传闻」「预计」「市场传言」类未经证实信息）。
 *  命中其一即视为 thesis 含未经证实信息，fitness 不应超过 cap。
 *  只匹配明示"未证实"语义的词，避免误伤"预计订单交付"这类正常前瞻表述——
 *  故排除单独的"预计"，要求它和"未证实/尚待/不确定"等修饰共存，或直接是"传闻/传言"。 */
const RUMOR_TERMS = [
    "传闻", "传言", "市场传言", "未经证实", "尚未证实", "尚待证实", "尚待验证",
    "待证实", "据称", "疑似", "据传",
];
/** 把 ratio 字符串（如 "0.4%"/"5"）解析成数字，失败返回 NaN。
 *  lockup.py 的 shares/ratio 都是字符串，规则 7 要判 ratio≥5 需 parse。 */
function parseRatio(s) {
    if (typeof s !== "string")
        return NaN;
    const m = s.match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : NaN;
}
function applyQualityGate(analyst, risk, data) {
    const issues = [];
    // 副本，不动入参（LLM 原始输出可能被 trace 记录，保持原样可审计）
    let fitness = analyst.fitness_score;
    let overallRisk = risk.overall_risk;
    const dealBreaker = risk.deal_breaker;
    const f = data.fundamentals;
    const thesis = analyst.thesis;
    // ── 钳制型 ──────────────────────────────────────────────
    // 规则 4（先做）：fitness 越界 → clamp 到 [0,10]
    // LLM 偶发输出 11 或负数，先归一化后续规则才有意义。
    if (fitness > 10 || fitness < 0) {
        const clamped = Math.max(0, Math.min(10, fitness));
        issues.push(`fitness ${fitness} 越界，clamp 到 ${clamped}`);
        fitness = clamped;
    }
    // 规则 1：数据缺失封顶。PE=0 或净利=0 说明基本面数据拉取失败/缺失，
    // 无法证实业绩，prompt 明确要求 fitness 不超过 6。LLM 若给更高分则钳制。
    // 这是整个门控的核心断点：幻觉净利 → 错误高分 → 错误建仓。
    const dataMissing = f.pe === 0 || f.np_q1 === 0;
    if (dataMissing && fitness > FITNESS_UNVERIFIABLE_CAP) {
        const missing = [
            f.pe === 0 ? "PE" : null,
            f.np_q1 === 0 ? "净利" : null,
        ].filter(Boolean).join("/");
        issues.push(`fitness ${fitness}→${FITNESS_UNVERIFIABLE_CAP}（${missing}=0 数据缺失，无法证实业绩）`);
        fitness = FITNESS_UNVERIFIABLE_CAP;
    }
    // 规则 2：传闻词封顶。thesis 明示"未经证实"类信息，prompt 要求最多 6 分。
    const hitRumor = RUMOR_TERMS.some(t => thesis.includes(t));
    if (hitRumor && fitness > FITNESS_UNVERIFIABLE_CAP) {
        issues.push(`fitness ${fitness}→${FITNESS_UNVERIFIABLE_CAP}（thesis 含传闻/未证实信息）`);
        fitness = FITNESS_UNVERIFIABLE_CAP;
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
    return {
        analyst: { ...analyst, fitness_score: fitness },
        risk: { ...risk, overall_risk: overallRisk },
        issues,
    };
}
//# sourceMappingURL=quality-gate.js.map