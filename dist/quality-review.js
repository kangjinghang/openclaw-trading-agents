"use strict";
// src/quality-review.ts
//
// Layer-2 LLM data-credibility review of analyst reports.
//
// The deterministic Layer-1 gate (quality-gate.ts) catches structural issues
// (empty/short/failure-marker/no-field-citation). This Layer-2 review catches
// SEMANTIC issues code cannot: fabricated numbers, stale data presented as
// current, internal inconsistency, cross-report contradictions. It runs once
// per analysis, after Layer-1 grading and before downstream consumers, and
// augments `summary_text` with a credibility verdict they already consume.
//
// Design constraints:
//  - Optional: skipped when ≥4 reports already hard-failed (not worth a call).
//  - Non-blocking: any failure (LLM throw / empty / unparseable) → null, and
//    the pipeline falls back to Layer-1 grades. Never throws.
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
exports.parseQualityReview = parseQualityReview;
exports.formatQualityReview = formatQualityReview;
exports.runQualityReview = runQualityReview;
const llm_client_1 = require("./llm-client");
const prompt_loader_1 = require("./prompt-loader");
const path = __importStar(require("path"));
const SKILLS_DIR = path.resolve(__dirname, "../skills");
/** Skip the LLM review when this many reports already hard-failed Layer 1 —
 *  not worth a review call when a majority are junk. Mirrors TA-astock's rule. */
const QUALITY_REVIEW_FAIL_THRESHOLD = 4;
const CREDIBILITY_LEVELS = new Set(["高", "中", "低"]);
/**
 * Parse a `<!-- QUALITY_REVIEW: {...} -->` JSON block from an LLM review turn.
 * Returns null on: missing block, malformed JSON, non-object payload, or a
 * `credibility` value outside 高/中/低. String-array fields are coerced to
 * empty defaults when missing so partial output is still usable.
 */
function parseQualityReview(content) {
    const match = content.match(/<!--\s*QUALITY_REVIEW:\s*(\{.*?\})\s*-->/s);
    if (!match)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(match[1]);
    }
    catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null;
    }
    const obj = parsed;
    const credibility = typeof obj.credibility === "string" ? obj.credibility : "";
    if (!CREDIBILITY_LEVELS.has(credibility))
        return null;
    const coerceStrArray = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    return {
        credibility: credibility,
        note: typeof obj.note === "string" ? obj.note : "",
        stale_reports: coerceStrArray(obj.stale_reports),
        fabrication_suspects: coerceStrArray(obj.fabrication_suspects),
    };
}
/**
 * Render a parsed review into a markdown section to append to the Layer-1
 * `summary_text`, so downstream agents (debate / research / trader / PM) see
 * the credibility signal alongside the grade table.
 */
function formatQualityReview(review) {
    const lines = ["\n## 数据可信度复核（LLM Layer-2）\n"];
    lines.push(`**数据可信度**：${review.credibility}`);
    if (review.note)
        lines.push(review.note);
    if (review.stale_reports.length > 0) {
        lines.push(`**数据时效存疑**：${review.stale_reports.join("、")}`);
    }
    if (review.fabrication_suspects.length > 0) {
        lines.push(`**数值可疑（建议降权）**：${review.fabrication_suspects.join("、")}`);
    }
    return lines.join("\n");
}
/**
 * Run the LLM Layer-2 credibility review over all analyst reports.
 *
 * Returns null (graceful degrade to Layer-1-only) when:
 *  - ≥4 reports already hard-failed Layer 1 (not worth a review call), or
 *  - the LLM call throws / returns empty / emits no parseable block.
 *
 * Never throws — this is an optional enrichment that must not block the pipeline.
 */
async function runQualityReview(reports, quality, ticker, date, config, client, traceLogger) {
    if (quality.failed_count >= QUALITY_REVIEW_FAIL_THRESHOLD) {
        return null;
    }
    const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");
    const gradesTable = quality.grades
        .map((g) => {
        const issuePart = g.issues.length ? `（${g.issues.join("；")}）` : "";
        return `- ${g.role}: ${g.grade}${issuePart}`;
    })
        .join("\n");
    const reportsText = reports
        .map((r) => `### ${r.role}（VERDICT: ${r.verdict.direction}）\n${r.content}`)
        .join("\n\n");
    const userMessage = (0, prompt_loader_1.loadAndRender)("quality_review.md", { ticker, date, grades_table: gradesTable, reports: reportsText }, promptsBaseDir);
    let content;
    try {
        const result = await (0, llm_client_1.callLLM)(client, {
            model: config.models.analyst,
            systemPrompt: "You are a data-quality reviewer auditing analyst reports for credibility (not investment merit).",
            userMessage,
            temperature: 0.2,
            phase: "quality_review",
            role: "quality_review",
            traceLogger,
        });
        content = result.content;
    }
    catch {
        return null;
    }
    return parseQualityReview(content);
}
//# sourceMappingURL=quality-review.js.map