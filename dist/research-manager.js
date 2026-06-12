"use strict";
// src/research-manager.ts
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
exports.runResearchManager = runResearchManager;
const llm_client_1 = require("./llm-client");
const prompt_loader_1 = require("./prompt-loader");
const path = __importStar(require("path"));
const SKILLS_DIR = path.resolve(__dirname, "../skills");
function parseScores(content) {
    // Match with or without markdown bold markers
    const bullMatch = content.match(/\*{0,2}多头得分\*{0,2}[：:]\s*(\d+)/) ||
        content.match(/bull.?score[：:]\s*(\d+)/i);
    const bearMatch = content.match(/\*{0,2}空头得分\*{0,2}[：:]\s*(\d+)/) ||
        content.match(/bear.?score[：:]\s*(\d+)/i);
    return {
        bull_score: bullMatch ? parseInt(bullMatch[1], 10) : 50,
        bear_score: bearMatch ? parseInt(bearMatch[1], 10) : 50,
    };
}
function parseConfidence(content) {
    const match = content.match(/\*{0,2}信心水平\*{0,2}[：:]\s*([\d.]+)/) ||
        content.match(/confidence[：:]\s*([\d.]+)/i);
    return match ? parseFloat(match[1]) : 0.5;
}
function parseDebatePoints(content) {
    const sectionMatch = content.match(/### 关键辩论焦点\s*\n([\s\S]*?)(?=\n###|\n<!-- VERDICT|$)/);
    if (!sectionMatch)
        return [];
    return sectionMatch[1].split("\n").map((l) => l.replace(/^\d+\.\s*/, "").trim()).filter(Boolean);
}
function parse5TierDirection(raw) {
    // Take the first option if LLM outputs "看多|看空|中性" style multi-choice
    const firstOption = raw.split("|")[0].trim();
    const n = firstOption.toLowerCase();
    if (n === "buy" || n === "买入" || n === "看多")
        return "Buy";
    if (n === "overweight" || n === "增持")
        return "Overweight";
    if (n === "hold" || n === "持有" || n === "中性")
        return "Hold";
    if (n === "underweight" || n === "减持")
        return "Underweight";
    if (n === "sell" || n === "卖出" || n === "看空")
        return "Sell";
    return "Hold";
}
async function runResearchManager(analystReports, debate, qualitySummary, config, openaiClient, traceLogger) {
    const promptsBaseDir = path.join(SKILLS_DIR, "trading-analysis", "prompts");
    const reportsText = analystReports
        .map((r) => `## ${r.role} 分析师\n${r.content}`)
        .join("\n\n");
    const debateRoundsText = debate.rounds
        .map((r) => {
        const bullText = r.bull_claims.map((c) => `[${c.id}] ${c.topic}（信心 ${c.confidence}）`).join("; ");
        const bearText = r.bear_claims.map((c) => `[${c.id}] ${c.topic}（信心 ${c.confidence}）`).join("; ");
        return `### Round ${r.round}\n多头论点：${bullText}\n空头论点：${bearText}`;
    })
        .join("\n\n");
    const userMessage = (0, prompt_loader_1.loadAndRender)("debate/research_manager.md", {
        ticker: "",
        date: "",
        analyst_reports: reportsText,
        debate_rounds: debateRoundsText,
        bull_summary: debate.bull_summary,
        bear_summary: debate.bear_summary,
        quality_summary: qualitySummary,
    }, promptsBaseDir);
    const result = await (0, llm_client_1.callLLM)(openaiClient, {
        model: config.models.decision_deep || config.models.decision,
        systemPrompt: "You are a research manager evaluating Bull↔Bear debate quality and making trading direction decisions.",
        userMessage,
        temperature: 0.3,
        phase: "research",
        role: "research_manager",
        traceLogger,
    });
    const verdict = (0, llm_client_1.parseVerdict)(result.content);
    const scores = parseScores(result.content);
    const confidence = parseConfidence(result.content);
    const keyPoints = parseDebatePoints(result.content);
    return {
        direction: parse5TierDirection(verdict?.direction || ""),
        confidence,
        bull_score: scores.bull_score,
        bear_score: scores.bear_score,
        reasoning: verdict?.reason || "",
        key_debate_points: keyPoints,
        verdict: verdict || { direction: "Hold", reason: "无法解析结论" },
    };
}
//# sourceMappingURL=research-manager.js.map