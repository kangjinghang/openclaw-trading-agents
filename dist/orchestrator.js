"use strict";
// src/orchestrator.ts
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
exports.generateDataQuality = generateDataQuality;
exports.buildTemplateVars = buildTemplateVars;
exports.calculateQuickConfidence = calculateQuickConfidence;
exports.runQuickAnalysis = runQuickAnalysis;
exports.extractLatestClose = extractLatestClose;
exports.runFullAnalysis = runFullAnalysis;
const exec_python_1 = require("./exec-python");
const constants_1 = require("./constants");
const prompt_loader_1 = require("./prompt-loader");
const llm_client_1 = require("./llm-client");
const trace_logger_1 = require("./trace-logger");
const report_store_1 = require("./report-store");
const debate_1 = require("./debate");
const research_manager_1 = require("./research-manager");
const trader_1 = require("./trader");
const risk_1 = require("./risk");
const quality_gate_1 = require("./quality-gate");
const quality_review_1 = require("./quality-review");
const cross_stage_checks_1 = require("./cross-stage-checks");
const errors_1 = require("./errors");
const constants_2 = require("./constants");
const pipeline_health_1 = require("./pipeline-health");
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const fs = __importStar(require("fs"));
const SKILLS_DIR = path.resolve(__dirname, "../skills");
// ── Market-data completeness thresholds ───────────────────────────
// These catch the two most dangerous silent failures: K-line returned far
// fewer bars than requested, or the source silently returned stale data.
// Tuned conservative to avoid false positives (新股/停牌/回测):
//  - MIN_BARS is an absolute floor, not a ratio, so newly-listed stocks
//    that simply have <50 bars of history are flagged correctly (TI needs
//    ≥50) without penalizing normal short-history tickers disproportionately.
//  - Freshness is checked ONLY when --date is within RECENT_WINDOW_DAYS of
//    today, so backtesting with an old --date never trips it. The stale gap
//    tolerance absorbs weekends + short holidays.
const KLINE_MIN_BARS = 50; // technical indicators (MACD/RSI/...) need ≥50 bars
const FRESHNESS_RECENT_WINDOW_DAYS = 7; // only check freshness for near-term analysis
const FRESHNESS_STALE_GAP_DAYS = 7; // weekend (~3d) + short-holiday headroom
/** Parse a "YYYY-MM-DD" prefix out of an arbitrary date-ish string. Returns null if none. */
function extractDateStr(s) {
    if (typeof s !== "string")
        return null;
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
/** Whole-day distance between two "YYYY-MM-DD" strings. 0 if either is unparseable. */
function daysBetween(a, b) {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (Number.isNaN(ta) || Number.isNaN(tb))
        return 0;
    return Math.abs(Math.round((tb - ta) / 86400000));
}
/** Is `date` within `windowDays` of `nowMs`? Used to gate freshness checks to near-term analysis. */
function isRecentDate(date, windowDays, nowMs = Date.now()) {
    const t = Date.parse(date);
    if (Number.isNaN(t))
        return false;
    return Math.abs(Math.round((nowMs - t) / 86400000)) <= windowDays;
}
/** Generate a data quality description for an analyst based on their ScriptResult. */
function generateDataQuality(role, date, result) {
    if (!result.success) {
        return "⚠️ 数据缺失：数据源获取失败，以下分析中必须明确声明数据不可用，不得推测或编造数据。置信度应降低。";
    }
    const issues = [];
    // Check for partial errors
    if (result.error) {
        issues.push(`数据源返回错误: ${result.error}`);
    }
    // Check data richness
    const data = result.data;
    if (data) {
        const fieldCount = Object.keys(data).length;
        const hasErrorFields = Object.keys(data).some(k => k.endsWith('_error'));
        if (hasErrorFields) {
            const errorFields = Object.keys(data).filter(k => k.endsWith('_error'));
            issues.push(`部分数据缺失: ${errorFields.map(k => k.replace('_error', '')).join(', ')}。请在分析中区分有数据支撑的结论和推测性结论。`);
        }
        if (fieldCount < 3) {
            issues.push(`数据字段较少（仅 ${fieldCount} 个字段），置信度应适当降低。`);
        }
        // Market-role completeness: K-line is the foundation of every downstream
        // judgment, so row-count and freshness get a dedicated, stricter check.
        if (role === "market") {
            const klineArr = Array.isArray(data.data) ? data.data : null;
            const rowCount = typeof data.count === "number"
                ? data.count
                : (klineArr?.length ?? 0);
            if (rowCount < KLINE_MIN_BARS) {
                issues.push(`K线仅 ${rowCount} 根（技术指标需 ≥${KLINE_MIN_BARS} 根），MACD/RSI/布林带等可能缺失，趋势判断不可靠，置信度应显著降低。`);
            }
            if (klineArr && klineArr.length > 0 && isRecentDate(date, FRESHNESS_RECENT_WINDOW_DAYS)) {
                const latestBarDate = extractDateStr(klineArr[klineArr.length - 1]?.date);
                const analysisDate = extractDateStr(date);
                if (latestBarDate && analysisDate) {
                    const gapDays = daysBetween(latestBarDate, analysisDate);
                    if (gapDays > FRESHNESS_STALE_GAP_DAYS) {
                        issues.push(`K线最新数据为 ${latestBarDate}，距分析日 ${analysisDate} 已 ${gapDays} 天，数据可能过期（停牌或数据源异常），置信度应降低。`);
                    }
                }
            }
        }
    }
    if (issues.length > 0) {
        return `⚠️ 数据部分缺失：${issues.join(' ')}`;
    }
    return "✅ 数据完整：数据源获取正常，所有字段可用。可以正常进行分析和判断。";
}
/**
 * Build template variable mapping for an analyst role.
 * Most roles use a 1:1 mapping { [dataKey]: dataJson }.
 * News, sentiment, and policy roles need the data JSON split into
 * multiple template variables to match their prompt templates
 * (e.g. {{stock_news}} + {{macro_news}} instead of {{news}}).
 */
function buildTemplateVars(role, dataKey, dataJson) {
    const defaults = { [dataKey]: dataJson };
    if (dataJson.startsWith("[数据缺失"))
        return defaults;
    let parsed;
    try {
        parsed = JSON.parse(dataJson);
    }
    catch {
        return defaults;
    }
    switch (role) {
        case "news":
        case "policy": {
            // Templates expect {{stock_news}} and {{macro_news}}.
            // news.py output: {stock_news, news_layers, layer_stats, macro_news, ...}
            const stockPart = {};
            if (parsed.stock_news !== undefined)
                stockPart.stock_news = parsed.stock_news;
            if (parsed.news_layers !== undefined)
                stockPart.news_layers = parsed.news_layers;
            if (parsed.layer_stats !== undefined)
                stockPart.layer_stats = parsed.layer_stats;
            const macroPart = {};
            if (parsed.macro_news !== undefined)
                macroPart.macro_news = parsed.macro_news;
            return {
                stock_news: Object.keys(stockPart).length > 0
                    ? JSON.stringify(stockPart, null, 2)
                    : "[数据缺失: 个股新闻]",
                macro_news: Object.keys(macroPart).length > 0
                    ? JSON.stringify(macroPart, null, 2)
                    : "[数据缺失: 宏观新闻]",
            };
        }
        case "sentiment":
            // Template expects {{sentiment_data}}, not {{sentiment}}
            return { sentiment_data: dataJson };
        default:
            return defaults;
    }
}
/** Generate analyst consensus summary from all analyst reports */
function generateAnalystConsensus(reports) {
    const validReports = reports.filter(r => !r.content.startsWith("[分析失败"));
    if (validReports.length === 0) {
        return "⚠️ 所有分析师报告均失败，无法计算一致性指标。";
    }
    const directionCounts = {};
    for (const report of validReports) {
        const dir = report.verdict.direction;
        if (!directionCounts[dir]) {
            directionCounts[dir] = { count: 0, roles: [] };
        }
        directionCounts[dir].count++;
        directionCounts[dir].roles.push(report.role);
    }
    const sorted = Object.entries(directionCounts).sort((a, b) => b[1].count - a[1].count);
    const total = validReports.length;
    const lines = [
        `### 分析师一致性指标（共 ${total} 位分析师）\n`,
    ];
    for (const [dir, info] of sorted) {
        const pct = Math.round(info.count / total * 100);
        lines.push(`- **${dir}**: ${info.count}/${total} (${pct}%) — ${info.roles.join(', ')}`);
    }
    const topDir = sorted[0][0];
    const topCount = sorted[0][1].count;
    const topPct = Math.round(topCount / total * 100);
    let divergence;
    if (topPct >= 70) {
        divergence = "低（高度一致）";
    }
    else if (topPct >= 50) {
        divergence = "中（多数一致）";
    }
    else {
        divergence = "高（分歧较大）";
    }
    lines.push(`\n**共识方向**: ${topDir} | **一致比例**: ${topPct}% | **分歧度**: ${divergence}`);
    // Decision guidance
    lines.push("\n**决策指引**:");
    if (topPct >= 70) {
        lines.push(`- 分析师高度一致（${topPct}% ${topDir}），可提高决策置信度`);
    }
    else if (topPct >= 50) {
        lines.push(`- 多数分析师一致（${topPct}% ${topDir}），建议适当降低仓位`);
    }
    else {
        lines.push(`- 分析师分歧较大（最高 ${topPct}% ${topDir}），建议降低仓位或持有观望`);
    }
    return lines.join("\n");
}
/** Pre-run validation: check environment before starting analysis */
/** Calculate quick-mode confidence based on analyst success rate and quality grades */
function calculateQuickConfidence(reports, quality) {
    const total = reports.length;
    if (total === 0)
        return 0.1;
    // Count successful analysts (not starting with error/skip marker)
    const succeeded = reports.filter(r => !r.content.startsWith("[分析失败") && !r.content.startsWith("[分析跳过")).length;
    const successRate = succeeded / total;
    // Count quality-validated analysts (grade A or B)
    const goodGrades = quality.grades.filter(g => g.grade === "A" || g.grade === "B").length;
    const gradeRate = goodGrades / total;
    // Weighted: 60% success rate + 40% grade quality
    // Capped at 0.85 (quick mode is inherently less thorough than full mode)
    const raw = 0.6 * successRate + 0.4 * gradeRate;
    return Math.round(Math.min(raw, 0.85) * 100) / 100;
}
/** Count successful analysts (not failed/skipped) */
function countSucceededAnalysts(reports) {
    return reports.filter(r => !r.content.startsWith("[分析失败") && !r.content.startsWith("[分析跳过")).length;
}
/** Pre-run validation: check environment before starting analysis */
function validateEnvironment(reportDir) {
    const errors = [];
    // Check report_dir is writable
    try {
        const absDir = reportDir.replace("~", os.homedir());
        fs.mkdirSync(absDir, { recursive: true });
        const testFile = path.join(absDir, ".write-test");
        fs.writeFileSync(testFile, "test", "utf-8");
        fs.unlinkSync(testFile);
    }
    catch (err) {
        errors.push(`report_dir "${reportDir}" is not writable: ${err.message}`);
    }
    // Check skills directory exists
    if (!fs.existsSync(SKILLS_DIR)) {
        errors.push(`skills directory not found: ${SKILLS_DIR}`);
    }
    if (errors.length > 0) {
        throw new errors_1.EnvironmentError(`环境预检失败:\n  ${errors.join("\n  ")}`);
    }
}
/** Generate a short run ID for log correlation */
function generateRunId() {
    return `run-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
}
/** Structured progress log to stderr */
function logProgress(runId, message, tokens, costUsd) {
    const ts = new Date().toISOString().slice(11, 19);
    let suffix = "";
    if (tokens !== undefined && costUsd !== undefined) {
        suffix = ` — ${tokens.toLocaleString()} tokens, $${costUsd.toFixed(4)}`;
    }
    console.error(`  [${ts}] [${runId.slice(0, 12)}] ${message}${suffix}`);
}
/**
 * Run tasks with limited concurrency and staggered start.
 * Adds a random jitter (0~staggerMs) before each task to avoid burst patterns.
 */
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
/**
 * Parse a direction string into a valid FinalDecision direction.
 * Supports Chinese and English direction names.
 */
/** Build a human-readable verdict summary for the analysts provenance stage */
function analystVerdictSummary(reports) {
    let bull = 0, bear = 0, neutral = 0;
    for (const r of reports) {
        const d = r.verdict.direction;
        if (d === "看多" || d === "Buy" || d === "Overweight" || d === "买入" || d === "增持")
            bull++;
        else if (d === "看空" || d === "Sell" || d === "Underweight" || d === "卖出" || d === "减持")
            bear++;
        else
            neutral++;
    }
    return `${bull}看多/${bear}看空/${neutral}中性`;
}
/** Build a human-readable rationale explaining WHY the final decision was reached. */
function generateDecisionRationale(analystReports, debate, researchDecision, riskAssessment) {
    const parts = [];
    // 1. Analyst consensus (reuse existing analystVerdictSummary)
    const summary = analystVerdictSummary(analystReports);
    parts.push(`分析师共识：${summary}`);
    // 2. Debate result
    if (debate.rounds.length > 0) {
        parts.push(`多空辩论：Bull ${researchDecision.bull_score} vs Bear ${researchDecision.bear_score}`);
    }
    // 3. Risk status
    if (riskAssessment.status !== "pass") {
        parts.push(`风控意见：${riskAssessment.status}`);
        if (riskAssessment.retries_exhausted) {
            parts.push(`（重试耗尽，保留原始决策）`);
        }
    }
    // 4. Technical vs fundamental conflict detection
    const marketAnalyst = analystReports.find(r => r.role === "market");
    const fundamentalsAnalyst = analystReports.find(r => r.role === "fundamentals");
    if (marketAnalyst && fundamentalsAnalyst) {
        const mDir = marketAnalyst.verdict.direction;
        const fDir = fundamentalsAnalyst.verdict.direction;
        const isBearish = mDir === "看空" || mDir === "Sell" || mDir === "Underweight";
        const isBullish = fDir === "看多" || fDir === "Buy" || fDir === "Overweight";
        if (isBearish && isBullish) {
            parts.push(`技术面看空但基本面看多，采用左侧逆向策略`);
        }
    }
    return parts.join("；");
}
function parseDirection(raw) {
    if (!raw)
        return "Hold";
    // Take the first option if LLM outputs "看多|看空|中性" style multi-choice
    const firstOption = raw.split("|")[0].trim();
    const normalized = firstOption.toLowerCase();
    // English mappings
    if (normalized === "buy" || normalized === "overweight")
        return "Buy";
    if (normalized === "hold" || normalized === "neutral")
        return "Hold";
    if (normalized === "sell" || normalized === "underweight")
        return "Sell";
    // Chinese mappings
    if (normalized === "买入" || normalized === "增持" || normalized === "看多")
        return "Buy";
    if (normalized === "持有" || normalized === "中性")
        return "Hold";
    if (normalized === "卖出" || normalized === "减持" || normalized === "看空")
        return "Sell";
    // Default to Hold for unrecognized directions
    return "Hold";
}
/** Analyst configuration: maps role → data script + prompt template + system prompt */
const ANALYST_CONFIGS = [
    {
        role: "market",
        script: "trading-kline/scripts/kline.py",
        prompt: "analysts/market.md",
        systemPrompt: "You are a professional market analyst specializing in Chinese A-share markets.",
        dataKey: "kline",
        extraArgs: (_ticker) => ["--count", "120"],
        timeoutMs: 60000, // K-line fetch + VPA + technical indicators can be slow
    },
    {
        role: "fundamentals",
        script: "trading-fundamentals/scripts/fundamentals.py",
        prompt: "analysts/fundamentals.md",
        systemPrompt: "You are a fundamentals analyst specializing in Chinese A-share markets, following CAS accounting standards.",
        dataKey: "fundamentals",
        extraArgs: () => [],
    },
    {
        role: "news",
        script: "trading-news/scripts/news.py",
        prompt: "analysts/news.md",
        systemPrompt: "You are a news analyst specializing in Chinese A-share markets.",
        dataKey: "news",
        extraArgs: () => ["--lookback-days", "7"],
    },
    {
        role: "sentiment",
        script: "trading-sentiment/scripts/sentiment.py",
        prompt: "analysts/sentiment.md",
        systemPrompt: "You are a market sentiment analyst specializing in Chinese A-share markets.",
        dataKey: "sentiment",
        extraArgs: () => [],
    },
    {
        role: "policy",
        script: "trading-news/scripts/news.py",
        prompt: "analysts/policy.md",
        systemPrompt: "You are a policy analyst specializing in Chinese A-share markets.",
        dataKey: "news",
        extraArgs: () => ["--lookback-days", "14"],
    },
    {
        role: "hot_money",
        script: "trading-hot-money/scripts/hot_money.py",
        prompt: "analysts/hot_money.md",
        systemPrompt: "You are a hot money tracker specializing in Chinese A-share markets.",
        dataKey: "hot_money",
        extraArgs: () => [],
    },
    {
        role: "lockup",
        script: "trading-lockup/scripts/lockup.py",
        prompt: "analysts/lockup.md",
        systemPrompt: "You are a lockup watcher specializing in Chinese A-share markets.",
        dataKey: "lockup",
        extraArgs: () => [],
    },
];
/** Get timeout for an analyst config, defaulting to PYTHON_SCRIPT_TIMEOUT_MS */
function scriptTimeout(cfg) {
    return cfg.timeoutMs ?? constants_1.PYTHON_SCRIPT_TIMEOUT_MS;
}
/** Save raw data source outputs to the report directory for traceability */
function saveRawData(detailDir, dataResults, subDirName) {
    const dataDir = path.join(detailDir, subDirName);
    fs.mkdirSync(dataDir, { recursive: true });
    for (const { role, result } of dataResults) {
        if (!result)
            continue;
        const filePath = path.join(dataDir, `${role}_raw.json`);
        try {
            const tmpPath = filePath + ".tmp";
            fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2), "utf-8");
            fs.renameSync(tmpPath, filePath);
        }
        catch (err) {
            console.error(`[saveRawData] Failed to write ${role}: ${err instanceof Error ? err.message : err}`);
        }
    }
}
/**
 * Shared Phase 1-2: fetch data + run 7 analysts in parallel.
 * Used by both runQuickAnalysis() and runFullAnalysis().
 */
async function runAnalystPhase(ticker, date, config, openaiClient, traceLogger, runId, health) {
    let totalTokens = 0;
    let totalCostUsd = 0;
    // ── Phase 1: Fetch data from all 7 scripts with concurrency limit ──
    logProgress(runId, "[1/4] 数据采集 7 个数据源...");
    const dataConcurrency = config.llm_concurrency || constants_2.DEFAULT_CONCURRENCY;
    const dataResults = new Array(ANALYST_CONFIGS.length);
    await pool(ANALYST_CONFIGS, async (cfg, idx) => {
        const scriptPath = path.join(SKILLS_DIR, cfg.script);
        const args = ["--ticker", ticker, "--date", date, ...cfg.extraArgs(ticker)];
        try {
            const result = await (0, exec_python_1.execPython)(scriptPath, args, null, 'python3', scriptTimeout(cfg));
            dataResults[idx] = { role: cfg.role, result };
            if (!result.success) {
                logProgress(runId, `  数据采集 ${cfg.role} 失败: ${result.error?.slice(0, 80)}`);
            }
        }
        catch (err) {
            dataResults[idx] = { role: cfg.role, result: { success: false, error: err.message } };
            logProgress(runId, `  数据采集 ${cfg.role} 异常: ${err.message?.slice(0, 80)}`);
        }
    }, dataConcurrency, constants_2.DATA_FETCH_STAGGER_MS);
    const dataFailed = dataResults.filter(d => !d.result.success).length;
    logProgress(runId, `[1/4] 数据采集完成 (${ANALYST_CONFIGS.length - dataFailed}/${ANALYST_CONFIGS.length} 成功${dataFailed > 0 ? `, ${dataFailed} 失败` : ""})`);
    // CP1: Data collection gate
    health.check("data_collection", "abort", "majority_scripts_failed", dataFailed < 6, `${dataFailed}/${ANALYST_CONFIGS.length} 数据源失败，无法进行有效分析`);
    if (health.hasAbort) {
        logProgress(runId, `❌ 管道中止: ${health.getIssues("data_collection").map(i => i.message).join("; ")}`);
        const fallbackName = dataResults.find(r => r.role === "fundamentals")?.result?.data?.valuation?.name
            || dataResults.find(r => r.role === "fundamentals")?.result?.data?.stock_info?.name
            || "";
        return { analystReports: [], totalTokens: 0, totalCostUsd: 0, dataResults, companyName: fallbackName };
    }
    for (const { role, result } of dataResults) {
        if (!result.success) {
            health.add({ stage: "data_collection", severity: "warn", check: "script_failed",
                message: `数据源 ${role} 获取失败: ${(result.error || "").slice(0, 60)}`, context: { role } });
        }
    }
    const dataMap = {};
    const vpaMap = {};
    const tiMap = {};
    const dataQualityMap = {};
    for (const { role, result } of dataResults) {
        if (result.success && result.data) {
            dataMap[role] = JSON.stringify(result.data, null, 2);
            if (result.vpa) {
                vpaMap[role] = result.vpa;
            }
            if (result.technical_indicators) {
                tiMap[role] = result.technical_indicators;
            }
        }
        else {
            dataMap[role] = `[数据缺失: ${result.error || "unknown error"}]`;
        }
        dataQualityMap[role] = generateDataQuality(role, date, result);
    }
    // Extract company name + industry from fundamentals data so all analysts
    // know the correct stock identity (prevents LLM fabricating wrong company).
    const fundamentalsData = dataResults.find(r => r.role === "fundamentals")?.result?.data;
    const companyName = fundamentalsData?.valuation?.name
        || fundamentalsData?.stock_info?.name
        || "";
    const industry = fundamentalsData?.stock_info?.industry || "";
    const companyInfo = companyName
        ? `${companyName}${industry ? `（${industry}）` : ""}（${ticker}）`
        : ticker;
    // ── Phase 2: Run all 7 analysts with concurrency limit ─────────
    logProgress(runId, "[2/4] 分析师阶段 7 个分析师...");
    const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");
    const analystReports = new Array(ANALYST_CONFIGS.length);
    const concurrency = config.llm_concurrency || constants_2.DEFAULT_CONCURRENCY;
    const rateLimitCoordinator = new llm_client_1.RateLimitCoordinator();
    await pool(ANALYST_CONFIGS, async (cfg, idx) => {
        try {
            // Adaptive: if a concurrent call hit 429, wait before starting this one
            await rateLimitCoordinator.waitIfNeeded();
            const dataJson = dataMap[cfg.role];
            const roleVars = buildTemplateVars(cfg.role, cfg.dataKey, dataJson);
            const userMessage = (0, prompt_loader_1.loadAndRender)(cfg.prompt, { ticker, date, company_info: companyInfo, ...roleVars, vpa: vpaMap[cfg.role] || "", technical_indicators: tiMap[cfg.role] || "", data_quality: dataQualityMap[cfg.role] }, promptsBaseDir);
            // CP2: Template render gate — detect un-replaced placeholders
            const remainingPlaceholders = userMessage.match(/\{\{(\w+)\}\}/g);
            if (remainingPlaceholders) {
                health.add({
                    stage: "template_render",
                    severity: "skip",
                    check: "placeholders_remaining",
                    message: `${cfg.role} 有 ${remainingPlaceholders.length} 个占位符未替换: ${remainingPlaceholders.join(", ")}`,
                    context: { role: cfg.role, placeholders: remainingPlaceholders.map(p => p.replace(/[{}]/g, "")) },
                });
                logProgress(runId, `  ⚠ 跳过 ${cfg.role}: 占位符未替换`);
                analystReports[idx] = {
                    role: cfg.role,
                    content: `[分析跳过: 模板占位符未替换 — ${remainingPlaceholders.join(", ")}]`,
                    verdict: { direction: "中性", reason: "模板渲染异常，数据未注入" },
                    data_sources_used: [],
                };
                return;
            }
            const llmResult = await (0, llm_client_1.callLLM)(openaiClient, {
                model: config.models.analyst,
                systemPrompt: cfg.systemPrompt,
                userMessage,
                temperature: 0.4,
                phase: "analyst",
                role: cfg.role,
                traceLogger,
                rateLimitCoordinator,
            });
            totalTokens += llmResult.usage.total_tokens;
            totalCostUsd += llmResult.costUsd;
            const verdict = (0, llm_client_1.parseVerdict)(llmResult.content);
            // CP3: Analyst output gate
            health.check("analyst_output", "warn", "verdict_missing", verdict !== null, `${cfg.role} VERDICT 解析失败，使用默认中性`, { role: cfg.role });
            health.check("analyst_output", "warn", "content_too_short", llmResult.content.length >= 200, `${cfg.role} 输出过短 (${llmResult.content.length} chars)，可能敷衍`, { role: cfg.role, contentLength: llmResult.content.length });
            analystReports[idx] = {
                role: cfg.role,
                content: llmResult.content,
                verdict: verdict || { direction: "中性", reason: "无法解析结论" },
                data_sources_used: [cfg.dataKey],
            };
        }
        catch (err) {
            logProgress(runId, `  分析师 ${cfg.role} 失败: ${err.message?.slice(0, 80)}`);
            analystReports[idx] = {
                role: cfg.role,
                content: `[分析失败: ${err.message}]`,
                verdict: { direction: "中性", reason: "分析失败" },
                data_sources_used: [],
            };
        }
    }, concurrency, constants_2.LLM_CALL_STAGGER_MS);
    const analystEmpty = analystReports.filter(r => r.content.startsWith("[分析失败")).length;
    logProgress(runId, `[2/4] 分析师阶段完成${analystEmpty > 0 ? ` (${analystEmpty} 个失败)` : ""}`);
    return { analystReports, totalTokens, totalCostUsd, dataResults, companyName };
}
/**
 * Run a quick analysis workflow with 7 parallel analysts:
 * 1. Fetch data from all 7 scripts in parallel (graceful degradation)
 * 2. Run all 7 analysts in parallel (graceful degradation)
 * 3. Portfolio Manager synthesizes all 7 reports
 * 4. Persist and return result
 */
async function runQuickAnalysis(ticker, date, config, openaiClient, signal) {
    const startTime = Date.now();
    const runId = generateRunId();
    const detailDir = path.join(config.report_dir.replace("~", os.homedir()), ticker, `${date}_quick`);
    // Isolate each run's traces under {traceDir}/{runId}/ so re-running the same
    // ticker+date doesn't accumulate prior runs' traces in one flat dir (which
    // made the call list unreadable and broke call_index ordering across runs).
    const traceDir = path.join(detailDir, "02_traces", runId);
    const traceLogger = new trace_logger_1.TraceLogger(traceDir, runId);
    const reportStore = new report_store_1.ReportStore(config.report_dir);
    logProgress(runId, `开始 Quick 分析 ${ticker} (${date})`);
    validateEnvironment(config.report_dir);
    const health = new pipeline_health_1.PipelineHealth(runId);
    const { analystReports, totalTokens, totalCostUsd, dataResults, companyName } = await runAnalystPhase(ticker, date, config, openaiClient, traceLogger, runId, health);
    if (signal?.aborted)
        throw new errors_1.AbortError();
    // ── Quality Gate ──────────────────────────────────────────────────
    const quality = (0, quality_gate_1.validateAnalystReports)(analystReports);
    // Layer-2 LLM credibility review (optional; degrades to Layer-1 on skip/failure)
    const qualityReview = await (0, quality_review_1.runQualityReview)(analystReports, quality, ticker, date, config, openaiClient, traceLogger);
    if (qualityReview)
        quality.summary_text += (0, quality_review_1.formatQualityReview)(qualityReview);
    logProgress(runId, `[2/4] 质量门控: ${quality.grades.map(g => `${g.role}=${g.grade}`).join(", ")}${qualityReview ? ` (可信度 ${qualityReview.credibility})` : ""}`);
    // CP4: Quality gate — register layer-1 grades
    for (const g of quality.grades) {
        if (g.grade === "D" || g.grade === "F") {
            health.add({ stage: "quality_gate", severity: "warn", check: "layer1_grade",
                message: `${g.role} 质量门评级 ${g.grade}: ${(g.issues || []).join("; ")}`,
                context: { role: g.role, grade: g.grade } });
        }
    }
    // CP5: Quality review — register layer-2 findings
    if (qualityReview) {
        for (const suspect of qualityReview.fabrication_suspects || []) {
            health.add({ stage: "quality_review", severity: "warn", check: "fabrication_suspect",
                message: `${suspect} 疑似编造数据`, context: { role: suspect } });
        }
    }
    // Persist the quality-gate output BEFORE downstream phases so a mid-run crash
    // still leaves the audit on disk. Previously this was only injected into
    // prompts (transient) — unrecoverable without grepping trace inputs after.
    reportStore.saveQualitySummary(ticker, date, "quick", quality, qualityReview);
    // ── Portfolio Manager ────────────────────────────────────────────
    logProgress(runId, "[3/4] 投资组合经理决策...");
    const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");
    const allReportsText = analystReports
        .map((r) => `## ${r.role} 分析师报告\n\n${r.content}\n\nVERDICT: ${r.verdict.direction} — ${r.verdict.reason}`)
        .join("\n\n---\n\n");
    const analystConsensus = generateAnalystConsensus(analystReports);
    const portfolioPrompt = (0, prompt_loader_1.loadAndRender)("portfolio_manager.md", { ticker, date, analyst_reports: allReportsText, quality_summary: quality.summary_text, analyst_consensus: analystConsensus }, promptsBaseDir);
    const portfolioResult = await (0, llm_client_1.callLLM)(openaiClient, {
        model: config.models.decision,
        systemPrompt: "You are a portfolio manager making final trading decisions based on analyst reports.",
        userMessage: portfolioPrompt,
        temperature: 0.3,
        phase: "portfolio",
        role: "portfolio_manager",
        traceLogger,
    });
    const allTokens = totalTokens + portfolioResult.usage.total_tokens;
    const allCost = totalCostUsd + portfolioResult.costUsd;
    const portfolioVerdict = (0, llm_client_1.parseVerdict)(portfolioResult.content);
    let direction;
    let reasoning;
    if (portfolioVerdict) {
        direction = parseDirection(portfolioVerdict.direction);
        reasoning = portfolioVerdict.reason;
    }
    else {
        // Fallback: majority vote from analysts
        logProgress(runId, "  WARNING: 投资组合经理结论解析失败，使用分析师多数意见");
        const verdictCounts = {};
        for (const report of analystReports) {
            verdictCounts[report.verdict.direction] = (verdictCounts[report.verdict.direction] || 0) + 1;
        }
        const majority = Object.entries(verdictCounts).sort((a, b) => b[1] - a[1])[0][0];
        direction = parseDirection(majority);
        reasoning = `投资组合经理解析失败，使用分析师多数意见 (${majority})`;
    }
    const analystVerdicts = {};
    for (const report of analystReports) {
        analystVerdicts[report.role] = report.verdict.direction;
    }
    const confidence = calculateQuickConfidence(analystReports, quality);
    // Warn when most analysts failed
    const succeeded = countSucceededAnalysts(analystReports);
    const totalAnalysts = analystReports.length;
    if (succeeded < totalAnalysts * 0.5) {
        reasoning = `⚠️ 仅 ${succeeded}/${totalAnalysts} 个分析师成功（其余因 API 限流或其他原因失败），置信度显著降低。${reasoning}`;
        logProgress(runId, `  ⚠ 低覆盖率: ${succeeded}/${totalAnalysts} 分析师成功，结论可靠性受限`);
    }
    const finalDecision = {
        ticker,
        company_name: companyName || ticker,
        date,
        direction,
        confidence,
        target_price: 0,
        stop_loss: 0,
        position_pct: 0,
        reasoning,
        key_risks: [],
        analyst_verdicts: analystVerdicts,
        bull_bear_summary: "",
        risk_assessment: "pass",
        execution_plan: "",
        next_review_trigger: "",
        decision_rationale: `投资组合经理决策：${direction}，置信度 ${(confidence * 100).toFixed(0)}%。分析师共识：${analystVerdictSummary(analystReports)}`,
    };
    const result = { ticker, date, mode: "quick", analysts: analystReports, final: finalDecision };
    const durationMs = Date.now() - startTime;
    logProgress(runId, `[4/4] 保存报告...`);
    const provenance = [
        { stage: "analysts", key_decision: analystVerdictSummary(analystReports), detail_ref: "01_analysts/" },
        { stage: "portfolio_manager", key_decision: `${finalDecision.direction} (${(finalDecision.confidence * 100).toFixed(0)}%)` },
    ];
    reportStore.save(ticker, date, "quick", result, durationMs, allTokens, allCost, runId, traceLogger.warnings, health.toJSON(), provenance);
    saveRawData(detailDir, dataResults, "03_data");
    logProgress(runId, `完成 (${(durationMs / 1000).toFixed(1)}s)`, allTokens, allCost);
    // Write run summary for auditing
    const meta = {
        run_id: runId,
        trace_dir: traceDir,
        duration_ms: durationMs,
        total_tokens: allTokens,
        total_cost_usd: allCost,
        llm_call_count: traceLogger.count,
        warnings: traceLogger.warnings,
        pipeline_health: health.toJSON(),
    };
    fs.writeFileSync(path.join(traceDir, "run_summary.json"), JSON.stringify({ ...meta, ticker, date, mode: "quick", direction }, null, 2), "utf-8");
    return [result, meta];
}
/**
 * Extract the most recent daily close from the market data script result, for
 * use as the market reference in cross-stage checks (target/stop on wrong side
 * of current price). Returns undefined when market data is missing/failed or
 * has no bars — callers skip the market-dependent checks in that case.
 */
function extractLatestClose(dataResults) {
    const market = dataResults.find((d) => d.role === "market");
    if (!market || !market.result.success || !market.result.data)
        return undefined;
    const arr = market.result.data.data;
    if (!Array.isArray(arr) || arr.length === 0)
        return undefined;
    const close = arr[arr.length - 1]?.close;
    return typeof close === "number" && close > 0 ? close : undefined;
}
/**
 * Run full analysis with debate and risk layers:
 * 1. 7 analysts (parallel) → 2. Bull↔Bear debate → 3. Research Manager
 * 4. Trader → 5. Risk Debate (3-way parallel) → 6. Risk Manager (with revise loop)
 */
async function runFullAnalysis(ticker, date, config, openaiClient, signal) {
    const startTime = Date.now();
    const runId = generateRunId();
    const detailDir = path.join(config.report_dir.replace("~", os.homedir()), ticker, `${date}_full`);
    // Isolate each run's traces under {traceDir}/{runId}/ (see runQuickAnalysis).
    const traceDir = path.join(detailDir, "06_traces", runId);
    const traceLogger = new trace_logger_1.TraceLogger(traceDir, runId);
    const reportStore = new report_store_1.ReportStore(config.report_dir);
    logProgress(runId, `开始 Full 分析 ${ticker} (${date})`);
    validateEnvironment(config.report_dir);
    // Phase 1-2: Analysts
    const health = new pipeline_health_1.PipelineHealth(runId);
    const { analystReports, dataResults, companyName } = await runAnalystPhase(ticker, date, config, openaiClient, traceLogger, runId, health);
    if (signal?.aborted)
        throw new errors_1.AbortError();
    // Quality Gate
    const quality = (0, quality_gate_1.validateAnalystReports)(analystReports);
    // Layer-2 LLM credibility review (optional; degrades to Layer-1 on skip/failure)
    const qualityReview = await (0, quality_review_1.runQualityReview)(analystReports, quality, ticker, date, config, openaiClient, traceLogger);
    if (qualityReview)
        quality.summary_text += (0, quality_review_1.formatQualityReview)(qualityReview);
    logProgress(runId, `质量门控: ${quality.grades.map(g => `${g.role}=${g.grade}`).join(", ")}${qualityReview ? ` (可信度 ${qualityReview.credibility})` : ""}`);
    // CP4: Quality gate — register layer-1 grades
    for (const g of quality.grades) {
        if (g.grade === "D" || g.grade === "F") {
            health.add({ stage: "quality_gate", severity: "warn", check: "layer1_grade",
                message: `${g.role} 质量门评级 ${g.grade}: ${(g.issues || []).join("; ")}`,
                context: { role: g.role, grade: g.grade } });
        }
    }
    // CP5: Quality review — register layer-2 findings
    if (qualityReview) {
        for (const suspect of qualityReview.fabrication_suspects || []) {
            health.add({ stage: "quality_review", severity: "warn", check: "fabrication_suspect",
                message: `${suspect} 疑似编造数据`, context: { role: suspect } });
        }
    }
    // Persist the quality-gate output BEFORE downstream phases so a mid-run crash
    // still leaves the audit on disk. Previously this was only injected into
    // prompts (transient) — unrecoverable without grepping trace inputs after.
    reportStore.saveQualitySummary(ticker, date, "full", quality, qualityReview);
    // Phase 3: Bull↔Bear Debate
    logProgress(runId, `[3/7] 多空辩论 (${config.debate_rounds} 轮)...`);
    const debate = await (0, debate_1.runBullBearDebate)(analystReports, quality.summary_text, config, openaiClient, traceLogger);
    logProgress(runId, `[3/7] 多空辩论完成 (Bull ${debate.rounds.flatMap(r => r.bull_claims).length} claims, Bear ${debate.rounds.flatMap(r => r.bear_claims).length} claims)`);
    // Debate divergence detection
    if (debate.convergence_score < 0.5) {
        health.add({
            stage: "debate",
            severity: "warn",
            check: "debate_divergence",
            message: `辩论收敛分数偏低 (${debate.convergence_score.toFixed(2)})，可能存在发散`,
            context: {
                convergence_score: debate.convergence_score,
                resolved_count: debate.resolved_points.length,
                unresolved_count: debate.rounds[debate.rounds.length - 1]?.unresolved_ids?.length || 0,
            },
        });
    }
    if (signal?.aborted)
        throw new errors_1.AbortError();
    // Phase 4: Research Manager
    logProgress(runId, `[4/7] 研究经理裁决...`);
    const researchDecision = await (0, research_manager_1.runResearchManager)(analystReports, debate, quality.summary_text, config, openaiClient, traceLogger);
    logProgress(runId, `[4/7] 研究经理裁决: ${researchDecision.direction} (信心 ${researchDecision.confidence})`);
    if (signal?.aborted)
        throw new errors_1.AbortError();
    // Phase 5: Trader
    logProgress(runId, `[5/7] 交易员制定执行计划...`);
    let tradingPlan = await (0, trader_1.runTrader)(researchDecision, analystReports, quality.summary_text, config, openaiClient, traceLogger, ticker, date);
    logProgress(runId, `[5/7] 交易计划: ${tradingPlan.direction} 目标价 ${tradingPlan.target_price} 止损 ${tradingPlan.stop_loss}`);
    if (signal?.aborted)
        throw new errors_1.AbortError();
    // Phase 6-7: Risk Debate + Risk Manager (with revise loop)
    logProgress(runId, `[6/7] 风控辩论 (3 方)...`);
    let riskDebate = await (0, risk_1.runRiskDebate)(tradingPlan, analystReports, config, openaiClient, traceLogger);
    logProgress(runId, `[6/7] 风控辩论完成`);
    logProgress(runId, `[7/7] 风控经理评估...`);
    let riskAssessment = await (0, risk_1.runRiskManager)(riskDebate, tradingPlan, config, openaiClient, traceLogger);
    let retries = 0;
    while (riskAssessment.status === "revise" && retries < config.max_risk_retries) {
        retries++;
        logProgress(runId, `  风控要求修订 (${retries}/${config.max_risk_retries}), 重新生成交易计划...`);
        // Inject the prior risk constraints into the trader so the revised plan
        // actually addresses them (instead of a blind retry). max_position_override
        // remains as a hard numeric cap fallback in case the LLM ignores hard_constraints.
        tradingPlan = await (0, trader_1.runTrader)(researchDecision, analystReports, quality.summary_text, config, openaiClient, traceLogger, ticker, date, riskAssessment.judge);
        if (riskAssessment.max_position_override) {
            tradingPlan.position_pct = Math.min(tradingPlan.position_pct, riskAssessment.max_position_override);
        }
        riskDebate = await (0, risk_1.runRiskDebate)(tradingPlan, analystReports, config, openaiClient, traceLogger);
        riskAssessment = await (0, risk_1.runRiskManager)(riskDebate, tradingPlan, config, openaiClient, traceLogger);
    }
    // If still revise after max retries, keep the honest verdict and flag it.
    // Previously this silently flipped status to "pass" while leaving the nested
    // judge object (still "revise") and reasoning ("禁止当日建仓...") untouched,
    // producing a self-contradictory report. Consumers (dashboard badge, report
    // formatter, final.risk_assessment propagation) already handle "revise".
    if (riskAssessment.status === "revise") {
        logProgress(runId, `  风控修订次数已达上限，保留 revise（已耗尽重试）`);
        riskAssessment = { ...riskAssessment, retries_exhausted: true };
    }
    // Apply the FINAL risk assessment's numeric position cap to the final plan.
    // The in-loop cap (above) only applied during revise retries, so without
    // this, a final judge saying "总仓位≤10%" never bound the final plan when
    // the loop didn't run (pass on first try) or exited revise-exhausted.
    // Regression: 600600 final judge said ≤10% but trader's 15% stood.
    if (riskAssessment.max_position_override !== undefined && riskAssessment.max_position_override < tradingPlan.position_pct) {
        logProgress(runId, `  风控硬约束：仓位 ${tradingPlan.position_pct}% → ${riskAssessment.max_position_override}%`);
        tradingPlan = { ...tradingPlan, position_pct: riskAssessment.max_position_override };
    }
    // Apply stop_loss constraint from risk hard_constraints.
    // Mirror the position cap pattern: enforce after loop, not inside.
    if (riskAssessment.judge?.hard_constraints) {
        for (const constraint of riskAssessment.judge.hard_constraints) {
            const stopLossMatch = constraint.match(/止损[价额]?(?:≥|>=|不低于|至少)\s*(\d+(?:\.\d+)?)/);
            if (stopLossMatch) {
                const minStopLoss = parseFloat(stopLossMatch[1]);
                if (tradingPlan.stop_loss < minStopLoss) {
                    logProgress(runId, `  风控硬约束：止损价 ${tradingPlan.stop_loss} → ${minStopLoss}`);
                    tradingPlan = { ...tradingPlan, stop_loss: minStopLoss };
                }
            }
        }
    }
    logProgress(runId, `[7/7] 风控评估: ${riskAssessment.status} (风险评分 ${riskAssessment.risk_score})`);
    // Assemble FinalDecision
    const analystVerdicts = {};
    for (const report of analystReports) {
        analystVerdicts[report.role] = report.verdict.direction;
    }
    const decisionRationale = generateDecisionRationale(analystReports, debate, researchDecision, riskAssessment);
    const finalDecision = {
        ticker,
        company_name: companyName || ticker,
        date,
        direction: tradingPlan.direction,
        confidence: researchDecision.confidence,
        target_price: tradingPlan.target_price,
        stop_loss: tradingPlan.stop_loss,
        position_pct: tradingPlan.position_pct,
        reasoning: researchDecision.reasoning,
        key_risks: tradingPlan.key_risks,
        analyst_verdicts: analystVerdicts,
        bull_bear_summary: `Bull: ${debate.bull_summary}\nBear: ${debate.bear_summary}`,
        risk_assessment: riskAssessment.status,
        execution_plan: tradingPlan.execution_plan,
        next_review_trigger: "",
        decision_rationale: decisionRationale,
    };
    const result = {
        ticker,
        date,
        mode: "full",
        analysts: analystReports,
        debate,
        research_decision: researchDecision,
        trading_plan: tradingPlan,
        risk_debate: riskDebate,
        risk_assessment: riskAssessment,
        final: finalDecision,
    };
    const durationMs = Date.now() - startTime;
    // Cross-stage consistency checks run LAST (all stages produced) against the
    // market's latest close — zero LLM cost, deterministic. Issues land in the
    // summary JSON so a reviewer sees structural anomalies (target on wrong side,
    // conservative-reject overruled, retries exhausted, …) at a glance.
    const latestClose = extractLatestClose(dataResults);
    const crossIssues = (0, cross_stage_checks_1.crossStageChecks)(result, latestClose);
    // CP6: Cross-stage — register all issues
    for (const issue of crossIssues) {
        health.add({ stage: "cross_stage", severity: issue.severity === "error" ? "warn" : "warn",
            check: issue.check, message: issue.message });
    }
    const fullProvenance = [
        { stage: "analysts", key_decision: analystVerdictSummary(analystReports), detail_ref: "01_analysts/" },
        { stage: "debate", key_decision: `Bull ${researchDecision.bull_score} vs Bear ${researchDecision.bear_score}`, detail_ref: "02_debate/" },
        { stage: "research", key_decision: `${researchDecision.direction} (${(researchDecision.confidence * 100).toFixed(0)}%)`, detail_ref: "03_research.json" },
        { stage: "trader", key_decision: `${tradingPlan.direction} target=${tradingPlan.target_price} stop=${tradingPlan.stop_loss} pos=${tradingPlan.position_pct}%`, detail_ref: "04_trading_plan.json" },
        { stage: "risk", key_decision: `${riskAssessment.status} (${riskAssessment.risk_score}/100)`, detail_ref: "05_risk/" },
    ];
    reportStore.saveFull(ticker, date, result, durationMs, traceLogger.totalTokens, traceLogger.totalCostUsd, runId, traceLogger.warnings, crossIssues, health.toJSON(), fullProvenance);
    saveRawData(detailDir, dataResults, "07_data");
    logProgress(runId, `完成 (${(durationMs / 1000).toFixed(1)}s, ${traceLogger.count} LLM calls)`, traceLogger.totalTokens, traceLogger.totalCostUsd);
    // Write run summary for auditing
    const meta = {
        run_id: runId,
        trace_dir: traceDir,
        duration_ms: durationMs,
        total_tokens: traceLogger.totalTokens,
        total_cost_usd: traceLogger.totalCostUsd,
        llm_call_count: traceLogger.count,
        warnings: traceLogger.warnings,
        pipeline_health: health.toJSON(),
    };
    fs.writeFileSync(path.join(traceDir, "run_summary.json"), JSON.stringify({ ...meta, ticker, date, mode: "full", direction: tradingPlan.direction }, null, 2), "utf-8");
    return [result, meta];
}
//# sourceMappingURL=orchestrator.js.map