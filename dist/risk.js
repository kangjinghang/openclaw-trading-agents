"use strict";
// src/risk.ts
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.RISK_ROLES = void 0;
exports.parseRiskArgument = parseRiskArgument;
exports.parseRiskJudge = parseRiskJudge;
exports.extractPositionCap = extractPositionCap;
exports.extractStopLossFromText = extractStopLossFromText;
exports.resolveMaxPosition = resolveMaxPosition;
exports.resolveMinStopLoss = resolveMinStopLoss;
exports.runRiskDebate = runRiskDebate;
exports.runRiskManager = runRiskManager;
const llm_client_1 = require("./llm-client");
const prompt_loader_1 = require("./prompt-loader");
const constants_1 = require("./constants");
const path = __importStar(require("path"));
const SKILLS_DIR = path.resolve(__dirname, "../skills");
/** Run tasks with limited concurrency and staggered start */
async function pool(items, fn, concurrency, staggerMs = 0) {
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            if (staggerMs > 0 && i > 0) {
                await new Promise((r) => setTimeout(r, Math.random() * staggerMs));
            }
            await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}
exports.RISK_ROLES = [
    {
        role: "aggressive",
        instructions: "你倾向于支持交易计划，做多风险因素的强势倡导者——不是无条件唱多，而是穷尽可行证据、在辩论中反驳保守方的悲观论调。从以下 A 股维度论证上行：(1) 政策底与产业催化：国务院/部委级扶持文件构成「政策底」，专项扶持、产业补贴、注册制红利是上行燃料；(2) 北向资金确认：沪深股通持续净流入是外资真金白银的背书，属趋势确认而非噪音；(3) 涨停板动量：T+1 反而抑制日内获利了结、利于多日连板，首板放量/缩量与龙头高度反映主力意志；(4) PE 扩张阶段：A 股牛市中成长股 PE 常扩张至 50-100x，过早套用美股 15-25x 会错过主升浪——以 30x 消化时间为锚，但 PEG<1 的高增速可容忍更高 PE；(5) 散户与游资放大器：散户占比高、羊群效应放大涨幅，游资接力制造短期强势。立场须有数据支撑，但你的任务是穷尽做多理由。",
    },
    {
        role: "conservative",
        instructions: "你倾向于审慎评估风险，做结构性风险的吹哨人——不是无条件看空，而是聚焦让多头计划崩塌的具体机制、在辩论中戳破乐观方的脆弱论据。从以下 A 股维度论证下行：(1) T+1 锁定风险（A 股最重大的结构性风险）：当日买入次日才能卖，开盘跳空下杀时损失被锁定、无法止损，急涨后追入者次日遇抛压即被套；(2) 涨跌停板陷阱：跌停板上卖单无法成交、被「焊死」，连续跌停可造成灾难性损失且无法离场；(3) 解禁与减持压力：解禁市值/流通市值 >20% 为重大压力，叠加减持新规抛压，是悬在头上的「卖出期权」、压制上行空间；(4) 政策反转风险：政策市的双刃剑——政府给的可以一夜收回，窗口指导、行业整顿可瞬时逆转预期；(5) 游资撤退信号：放量滞涨、连板断裂、龙头补跌是离场前兆；(6) 估值纪律：PE>50x 且 PEG>2 属投机，以 30x 锚消化需 5 年以上则明显高估；ST/退市风险须纳入仓位考量。你的任务是让风控经理看见最坏情况。",
    },
    {
        role: "neutral",
        instructions: "你持中立立场，做条件性、可证伪的平衡评估——不站队多空，而是把激进/保守两方论点拆解为可验证的条件、指出各自何时成立。核心视角：(1) T+1 是双刃剑：既锁定损失（保守方观点），也抑制恐慌抛售、利于多日趋势延续（激进方观点）——中立结论是仓位须小到能扛住单日跳空；(2) 政策信号分层：区分国务院顶层指令（高确定性）vs 部委通知（中等）vs 地方激励（较低可靠性）vs 市场传闻（噪音），据此给政策催化打折；(3) 北向资金定位：作为趋势确认信号而非独立做多理由，背离时是警示；(4) 估值区间法（非刚性阈值）：给定盈利轨迹下提出可辩护的 PE 区间而非单一阈值；(5) 板块轮动周期：A 股题材轮动快（典型 2-4 周），判断处于轮动早期（空间仍在）还是末期（上行有限、下行放大）；(6) 仓位管理优先于方向判断：在 ±10-20% 涨跌停 + T+1 的市场里，「买多少」比「买不买」更重要——这是中立派对 A 股风险的核心命题。你的任务是给出计划在何种条件下成立/不成立的分情景判断。",
    },
];
function parseRiskArgument(content, role) {
    const verdictMatch = content.match(/verdict[：:*]+\s*(pass|revise|reject)/i) ||
        content.match(/结论[：:*]+\s*(pass|revise|reject|通过|修订|拒绝)/i);
    let verdict = "pass";
    if (verdictMatch) {
        const raw = verdictMatch[1].toLowerCase();
        if (raw === "revise" || raw === "修订")
            verdict = "revise";
        else if (raw === "reject" || raw === "拒绝")
            verdict = "reject";
    }
    // evidence：按子标题分割（## 证据N：... 或 ### 证据N：...），保留标题文字作为证据摘要
    const evidenceRegex = /#{2,3}\s*证据[一二三四五六七八九十\d]+[：:]\s*(.+?)(?=#{2,3}\s*证据|\n#{2,3}\s*\d|$)/gs;
    const evidenceMatches = content.match(evidenceRegex) || [];
    const evidence = evidenceMatches
        .map((m) => m.replace(/^#{2,3}\s*/, "").trim())
        .filter((e) => e.length > 0);
    // 如果没有子标题格式，回退到 bullet list 格式
    if (evidence.length === 0) {
        const evidenceSection = content.match(/#{2,3}\s*2\.?\s*证据支撑.*\n([\s\S]*?)(?=\n+#{2,3}\s*\d)/);
        if (evidenceSection) {
            const bulletMatches = evidenceSection[1].match(/^- (.+)/gm) || [];
            evidence.push(...bulletMatches.map((m) => m.replace(/^- /, "").trim()));
        }
    }
    // 支持 ## 和 ### 两种标题级别，匹配立场声明到下一个标题为止
    const positionMatch = content.match(/#{2,3}\s*1\.?\s*立场声明([\s\S]*?)(?=\n+#{2,3}\s*\d)/);
    return {
        role,
        position: positionMatch ? positionMatch[1].trim() : "",
        evidence,
        verdict,
    };
}
const RISK_VERDICTS = new Set(["pass", "revise", "reject"]);
/**
 * Parse a `<!-- RISK_JUDGE: {...} -->` JSON block from risk-manager output.
 * Returns null on: missing block, malformed JSON, non-object payload, or a
 * `verdict` value outside pass/revise/reject. Missing optional constraint
 * arrays are coerced to empty defaults so partial LLM output is still usable.
 */
function parseRiskJudge(content) {
    const jsonStr = (0, llm_client_1.extractTaggedJson)(content, "RISK_JUDGE");
    if (!jsonStr)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(jsonStr);
    }
    catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null;
    }
    const obj = parsed;
    const verdictRaw = typeof obj.verdict === "string" ? obj.verdict.toLowerCase() : "";
    if (!RISK_VERDICTS.has(verdictRaw))
        return null;
    const coerceStrArray = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    // 权威数值字段：prompt 要求 LLM 直接在 RISK_JUDGE 里填这两个数字。校验为数字且
    // 范围合法后 clamp。非法值（NaN/越界）忽略 → 走正则 fallback（resolveMaxPosition）。
    // 这两个字段是"强类型数值替代正则反推"的主路径，消除正则漏匹配导致 cap 静默失效。
    const max_position_pct = typeof obj.max_position_pct === "number" && Number.isFinite(obj.max_position_pct)
        ? Math.max(0, Math.min(100, obj.max_position_pct))
        : undefined;
    const min_stop_loss = typeof obj.min_stop_loss === "number" && Number.isFinite(obj.min_stop_loss) && obj.min_stop_loss > 0
        ? obj.min_stop_loss
        : undefined;
    return {
        verdict: verdictRaw,
        reason: typeof obj.reason === "string" ? obj.reason : "",
        hard_constraints: coerceStrArray(obj.hard_constraints),
        soft_constraints: coerceStrArray(obj.soft_constraints),
        execution_preconditions: coerceStrArray(obj.execution_preconditions),
        de_risk_triggers: coerceStrArray(obj.de_risk_triggers),
        ...(max_position_pct !== undefined ? { max_position_pct } : {}),
        ...(min_stop_loss !== undefined ? { min_stop_loss } : {}),
    };
}
/**
 * Extract a numeric total-position cap (%) from `hard_constraints` text like
 * "总仓位≤10%", "仓位不超过20%", "最终持仓≤30%". Returns the SMALLEST cap found
 * (most restrictive) when multiple constraints apply. Returns undefined when
 * no total-position constraint is present — callers treat undefined as "no
 * override" and leave position_pct unchanged.
 *
 * Matches both "仓位" and "持仓" — they're synonyms in A-share trading and the
 * LLM emits either (600600 real run used "最终持仓≤30%"; an earlier run used
 * "总仓位≤10%"). The % sign is REQUIRED: it's what distinguishes a position-
 * PERCENT cap from an absolute-quantity constraint like "持仓量≤100万手"
 * (open interest) or "持仓≤1000股" (share count), which must NOT be treated
 * as a percentage cap.
 *
 * Why text extraction instead of a dedicated RISK_JUDGE field: the cap already
 * lives in hard_constraints (the LLM emits it there naturally — confirmed on
 * 600600); adding a parallel numeric field risks the two disagreeing. Zero
 * extra LLM cost, deterministic.
 *
 * Sub-batch constraints ("首批建仓≤5%", "首笔仓位≤3%", "分批…", "加仓…") are
 * explicitly skipped — they cap a tranche, not the total.
 */
function extractPositionCap(hardConstraints) {
    if (!hardConstraints || hardConstraints.length === 0)
        return undefined;
    const caps = [];
    for (const c of hardConstraints) {
        // Skip sub-batch constraints — they're not total-position caps.
        if (/首批|首笔|首次|分批|加仓|单批|每批|单次/.test(c))
            continue;
        // Pattern 1: "仓位≤30%" / "持仓不超过20%" (keyword directly before operator)
        const m1 = c.match(/(?:仓位|持仓)\s*(?:≤|<=|不超过|不多于|最多|上限)\s*(\d{1,3})\s*%/);
        if (m1) {
            const val = parseInt(m1[1], 10);
            if (val > 0 && val <= 100)
                caps.push(val);
            continue;
        }
        // Pattern 2: "减仓比例≤总持仓20%" (X比例/X规模 before operator, number after filler)
        const m2 = c.match(/(?:减仓|增仓|建仓|仓位|持仓)(?:比例|规模)?\s*(?:≤|<=|不超过|不多于|最多|上限)\s*(?:[\u4e00-\u9fa5]*?)\s*(\d{1,3})\s*%/);
        if (m2) {
            const val = parseInt(m2[1], 10);
            if (val > 0 && val <= 100)
                caps.push(val);
        }
    }
    return caps.length > 0 ? Math.min(...caps) : undefined;
}
/** 从 hard_constraints 文本里抽止损价下限（元），如 "止损价≥60.5元"。
 *  仅用于 resolveMinStopLoss 的 fallback（数值字段缺失时）。提取多个时取最大值
 *  （最严格：要求更高的止损价）。无匹配返回 undefined。 */
function extractStopLossFromText(hardConstraints) {
    if (!hardConstraints || hardConstraints.length === 0)
        return undefined;
    const floors = [];
    for (const c of hardConstraints) {
        const m = c.match(/止损[价额]?(?:≥|>=|不低于|至少)\s*(\d+(?:\.\d+)?)/);
        if (m) {
            const v = parseFloat(m[1]);
            if (Number.isFinite(v) && v > 0)
                floors.push(v);
        }
    }
    return floors.length > 0 ? Math.max(...floors) : undefined;
}
/**
 * 解析仓位上限的统一入口：数值字段优先，正则 fallback。
 *
 * - judge.max_position_pct 存在 → 直接用（已 clamp 0-100），这是权威路径
 * - 否则 fallback 到 extractPositionCap(hard_constraints)（旧正则，兜底）
 *
 * 返回 cap（undefined = 无上限）+ mismatch 标志。mismatch=true 表示数值字段
 * 与正则抽出的值不一致（差值 > 0.5%）——调用方应 recordWarning，但仍以数值字段为准。
 * 这是对"正则反推"系统弱点的收敛：数值字段为单一权威源，正则仅兜底 + 一致性校验。
 */
function resolveMaxPosition(judge) {
    if (!judge)
        return { cap: undefined, mismatch: false };
    const fromField = judge.max_position_pct;
    const fromRegex = extractPositionCap(judge.hard_constraints);
    if (fromField !== undefined) {
        // 数值字段权威。与正则抽出的值比对（仅当两者都有时），不一致记 mismatch。
        const mismatch = fromRegex !== undefined && Math.abs(fromField - fromRegex) > 0.5;
        return { cap: fromField, mismatch };
    }
    // 数值字段缺失 → 正则 fallback（旧行为，cap 可能因正则漏匹配而 undefined）
    return { cap: fromRegex, mismatch: false };
}
/**
 * 解析止损价下限的统一入口：数值字段优先，正则 fallback。与 resolveMaxPosition
 * 对称。orchestrator 用它替代内联的 hard_constraints 正则。
 */
function resolveMinStopLoss(judge) {
    if (!judge)
        return { floor: undefined, mismatch: false };
    const fromField = judge.min_stop_loss;
    const fromRegex = extractStopLossFromText(judge.hard_constraints);
    if (fromField !== undefined) {
        const mismatch = fromRegex !== undefined && Math.abs(fromField - fromRegex) > 0.01;
        return { floor: fromField, mismatch };
    }
    return { floor: fromRegex, mismatch: false };
}
async function runRiskDebate(tradingPlan, analystReports, config, openaiClient, traceLogger) {
    const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");
    const reportsText = analystReports
        .map((r) => `## ${r.role} 分析师\n${r.content}`)
        .join("\n\n");
    const planText = `方向：${tradingPlan.direction}\n目标价：${tradingPlan.target_price}\n止损：${tradingPlan.stop_loss}\n仓位：${tradingPlan.position_pct}%\n执行计划：${tradingPlan.execution_plan}`;
    const riskArguments = new Array(exports.RISK_ROLES.length);
    const concurrency = config.llm_concurrency || constants_1.DEFAULT_LLM_CONCURRENCY;
    const rateLimitCoordinator = new llm_client_1.RateLimitCoordinator();
    let accumulatedTokens = 0;
    let accumulatedCost = 0;
    await pool(exports.RISK_ROLES, async ({ role, instructions }, idx) => {
        await rateLimitCoordinator.waitIfNeeded();
        const riskRoleLabel = role === "aggressive" ? "激进风控" : role === "conservative" ? "保守风控" : "中性风控";
        const userMessage = (0, prompt_loader_1.loadAndRender)("debate/risk_debater.md", {
            ticker: "",
            date: "",
            trading_plan: planText,
            analyst_reports: reportsText,
            risk_role: riskRoleLabel,
            risk_role_instructions: instructions,
        }, promptsBaseDir);
        const result = await (0, llm_client_1.callLLM)(openaiClient, {
            model: config.models.risk,
            systemPrompt: `You are a ${role} risk assessor for A-share trading.`,
            userMessage,
            temperature: 0.4,
            phase: "risk_debate",
            role: `${role}_risk`,
            traceLogger,
            rateLimitCoordinator,
        });
        accumulatedTokens += result.usage.total_tokens;
        accumulatedCost += result.costUsd;
        riskArguments[idx] = parseRiskArgument(result.content, role);
    }, concurrency, constants_1.LLM_CALL_STAGGER_MS);
    return {
        rounds: [riskArguments],
        risk_arguments: riskArguments,
        total_tokens: accumulatedTokens,
        total_cost_usd: accumulatedCost,
    };
}
async function runRiskManager(riskDebate, tradingPlan, config, openaiClient, traceLogger) {
    const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");
    const planText = `方向：${tradingPlan.direction}\n目标价：${tradingPlan.target_price}\n止损：${tradingPlan.stop_loss}\n仓位：${tradingPlan.position_pct}%\n执行计划：${tradingPlan.execution_plan}`;
    const riskArgsText = riskDebate.risk_arguments
        .map((a) => `### ${a.role === "aggressive" ? "激进" : a.role === "conservative" ? "保守" : "中性"}风控\n立场：${a.position}\nverdict：${a.verdict}\n证据：${a.evidence.join("；")}`)
        .join("\n\n");
    const userMessage = (0, prompt_loader_1.loadAndRender)("debate/risk_manager.md", { ticker: "", date: "", trading_plan: planText, risk_arguments: riskArgsText }, promptsBaseDir);
    const result = await (0, llm_client_1.callLLM)(openaiClient, {
        model: config.models.decision_deep || config.models.risk,
        systemPrompt: "You are a risk manager making final pass/revise/reject decisions for A-share trading plans.",
        userMessage,
        temperature: 0.3,
        phase: "risk",
        role: "risk_manager",
        traceLogger,
    });
    // Prefer structured RISK_JUDGE block; fall back to VERDICT when absent.
    const judge = parseRiskJudge(result.content);
    const verdict = (0, llm_client_1.parseVerdict)(result.content);
    let status;
    if (!judge && !verdict) {
        // Scariest fallback: nothing parseable → status silently "pass". Surface
        // it as an error so a reviewer sees the plan was rubber-stamped by default.
        status = "pass";
        traceLogger.recordWarning({
            phase: "risk",
            fn: "runRiskManager",
            detail: "RISK_JUDGE 与 VERDICT 均缺失，status 默认 pass（无法解析风控结论）",
            severity: "error",
        });
    }
    else {
        // RISK_JUDGE 是结构化主路径（已白名单校验）。VERDICT 是降级路径，但 parseVerdict
        // 返回的是方向词（Buy/Sell/Hold/看多/看空/中性…），**绝非风控状态词**。直接强转
        // 会让 status 落成 "buy"/"sell"/"hold" 等从未被定义的值——下游 orchestrator 的
        // revise 循环不触发、crossStageChecks 的 pass 判断不成立、final.risk_assessment
        // 字段被污染成非法状态。这里对降级值也走白名单，非法一律归 pass + error 级警告。
        const rawStatus = (judge?.verdict || verdict?.direction || "pass").toLowerCase();
        if (RISK_VERDICTS.has(rawStatus)) {
            status = rawStatus;
        }
        else {
            status = "pass";
            traceLogger.recordWarning({
                phase: "risk",
                fn: "runRiskManager",
                detail: `VERDICT 降级值 "${verdict?.direction}" 不是合法风控状态（pass/revise/reject），status 默认 pass`,
                severity: "error",
            });
        }
    }
    // 仓位上限：数值字段优先（max_position_pct 权威），正则 fallback。
    const { cap: max_position_override, mismatch: posCapMismatch } = resolveMaxPosition(judge);
    // Risk produced hard constraints but none yielded a position-% cap → the
    // plan's position_pct is uncapped. This is the class behind the 600600
    // "judge says ≤10% but position stayed 15%" regression (a cap the regex
    // couldn't extract). Only warn when there's a real position to cap AND the
    // direction is buy-side — for Sell/Underweight, position_pct is the clear
    // ratio (100% = full exit), not a build ratio, so the cap concept doesn't
    // apply and the warning is a false positive (688662 real-run finding).
    const isSellSide = tradingPlan.direction === "Sell" || tradingPlan.direction === "Underweight";
    if (judge &&
        judge.hard_constraints.length > 0 &&
        max_position_override === undefined &&
        tradingPlan.position_pct > 0 &&
        !isSellSide) {
        traceLogger.recordWarning({
            phase: "risk",
            fn: "resolveMaxPosition",
            detail: `有 ${judge.hard_constraints.length} 条硬约束但未提取到仓位% cap，position_pct=${tradingPlan.position_pct}% 未被风控约束`,
            severity: "warn",
        });
    }
    // 数值字段与正则抽出的值不一致 → 以数值字段为准，但记录可审计（防 LLM 填的数字与
    // 文本描述漂移，下游悄无声息地用了错误的 cap）。
    if (posCapMismatch && judge?.max_position_pct !== undefined) {
        traceLogger.recordWarning({
            phase: "risk",
            fn: "resolveMaxPosition",
            detail: `max_position_pct=${judge.max_position_pct}% 与 hard_constraints 文本不一致，以数值字段为准`,
            severity: "warn",
        });
    }
    const scoreMatch = result.content.match(/风险评分[（(]0-100[)）]?[：:]*\s*\n?\s*(\d+)/) ||
        result.content.match(/risk.?score[：:]*\s*\n?\s*(\d+)/i);
    return {
        status,
        judge: judge ?? undefined,
        reasoning: judge?.reason || verdict?.reason || "",
        risk_score: scoreMatch ? parseInt(scoreMatch[1], 10) : 50,
        max_position_override,
    };
}
//# sourceMappingURL=risk.js.map