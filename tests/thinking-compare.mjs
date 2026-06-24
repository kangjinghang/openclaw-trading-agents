// 对比有/无 thinking disabled 对 LLM 输出质量和速度的影响
// 从 trace 文件提取 prompt 用两种 setting 回放调用 API
//
// Usage: node tests/thinking-compare.mjs

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import OpenAI from "openai";

const API_KEY = process.env.OPENAI_API_KEY || "04449db5f1814765af8c57e083a41171.xEyPrpeMZ4OZGiTm";
const BASE_URL = process.env.OPENAI_BASE_URL || "https://open.bigmodel.cn/api/coding/paas/v4";
const MODEL = process.env.OPENAI_MODEL || "glm-5-turbo";

const client = new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL });

async function callModel(systemPrompt, userMessage, thinkingDisabled) {
  const start = Date.now();
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0,
    max_tokens: 32000,
  };
  if (thinkingDisabled) {
    body.thinking = { type: "disabled" };
  }
  const response = await client.chat.completions.create(body);
  const durationMs = Date.now() - start;
  const content = response.choices[0]?.message?.content || "";
  return { content, durationMs };
}

function extractJson(content) {
  const t = content.trim();
  if (t.startsWith("{")) return t;
  const m = t.match(/\{[\s\S]*\}/);
  return m ? m[0] : t;
}

function compareRankings(baseline, newR) {
  const bTickers = baseline.map(r => r.ticker);
  const nTickers = newR.map(r => r.ticker);
  const overlap = bTickers.filter(t => nTickers.includes(t)).length;
  let topSame = 0;
  for (let i = 0; i < Math.min(bTickers.length, nTickers.length); i++) {
    if (bTickers[i] === nTickers[i]) topSame++;
  }
  let scoreDiff = 0, count = 0;
  for (const b of baseline) {
    const n = newR.find(r => r.ticker === b.ticker);
    if (n) { scoreDiff += Math.abs(b.score - n.score); count++; }
  }
  return { overlap, topSame, scoreDiff: count > 0 ? (scoreDiff / count).toFixed(2) : "-" };
}

async function main() {
  console.log("\n=== GLM-5-turbo thinking disabled 对比测试 ===\n");

  // ── 1. Rank traces ──
  const home = os.homedir();
  const rankTraceDir = path.join(home, ".openclaw", "watchlist", "scan", "2026-06-23", "traces");
  console.log("## 1. Rank traces\n");

  const rankFiles = fs.readdirSync(rankTraceDir)
    .filter(f => f.includes("ranker-trace-") && !f.includes("baseline"))
    .map(f => path.join(rankTraceDir, f));

  for (const fp of rankFiles) {
    const trace = JSON.parse(fs.readFileSync(fp, "utf-8"));
    const role = trace.role;
    const baselineJson = extractJson(trace.response.raw_content);
    const baselineParsed = JSON.parse(baselineJson);
    const bRanked = baselineParsed.ranked || [];

    // Call WITHOUT thinking disabled
    const r1 = await callModel(trace.request.system_prompt, trace.request.user_message, false);
    const j1 = extractJson(r1.content);
    const p1 = JSON.parse(j1);
    const nRanked = p1.ranked || [];

    // Call WITH thinking disabled
    const r2 = await callModel(trace.request.system_prompt, trace.request.user_message, true);
    const j2 = extractJson(r2.content);
    const p2 = JSON.parse(j2);
    const dRanked = p2.ranked || [];

    const cmp1 = compareRankings(bRanked, nRanked);
    const cmp2 = compareRankings(bRanked, dRanked);

    console.log(`### ${role}`);
    console.log(`| 指标 | trace (原始, 无thinking disabled) | 本次调用无 thinking disabled | 本次调用有 thinking disabled |`);
    console.log(`|---|---|---|---|`);
    console.log(`| 耗时 | ${trace.meta.duration_ms}ms | ${r1.durationMs}ms | ${r2.durationMs}ms |`);
    console.log(`| top-${Math.min(3, bRanked.length)} 一致 | - | ${cmp1.topSame}/${Math.min(3, bRanked.length)} | ${cmp2.topSame}/${Math.min(3, bRanked.length)} |`);
    console.log(`| ticker 重叠 | - | ${cmp1.overlap}/${bRanked.length} | ${cmp2.overlap}/${bRanked.length} |`);
    console.log(`| 平均分差 | - | ${cmp1.scoreDiff} | ${cmp2.scoreDiff} |`);
    console.log(`| completion tokens | ${trace.meta.usage.completion_tokens} | ${p1.usage?.completion_tokens || "?"} | ${p2.usage?.completion_tokens || "?"} |`);

    console.log(`\ntrace 原始 top-3:`);
    bRanked.slice(0, 3).forEach((r, i) => console.log(`  ${i+1}. ${r.ticker} score=${r.score}  ${(r.reason||"").slice(0,70)}`));
    console.log(`本次有 disabled top-3:`);
    dRanked.slice(0, 3).forEach((r, i) => console.log(`  ${i+1}. ${r.ticker} score=${r.score}  ${(r.reason||"").slice(0,70)}`));
    console.log();
  }

  // ── 2. Shallow-analyzer traces ──
  const rebTraceDir = path.join(home, ".openclaw", "watchlist", "rebalance", "2026-06-23", "traces");
  console.log("\n## 2. Shallow-analyzer traces\n");

  const shallowFiles = fs.readdirSync(rebTraceDir)
    .filter(f => f.includes("analyst-shallow-trace-") || f.includes("risk-shallow-trace-"))
    .map(f => path.join(rebTraceDir, f));

  for (const fp of shallowFiles.slice(0, 4)) {
    const trace = JSON.parse(fs.readFileSync(fp, "utf-8"));
    const role = trace.role;
    const baselineStr = trace.response.raw_content;

    // Call WITHOUT thinking disabled
    const r1 = await callModel(trace.request.system_prompt, trace.request.user_message, false);
    // Call WITH thinking disabled
    const r2 = await callModel(trace.request.system_prompt, trace.request.user_message, true);
    const j1 = extractJson(r1.content);
    const j2 = extractJson(r2.content);

    const same1 = j1 === baselineStr.trim() ? "✓" : "✗";
    const same2 = j2 === baselineStr.trim() ? "✓" : "✗";

    // Extract key fields
    const extractFields = (j, isAnalyst) => {
      try {
        const d = JSON.parse(j);
        if (isAnalyst) return { fitness: d.fitness_score, thesis: (d.thesis||"").slice(0,70) };
        return { risk: d.overall_risk, flags: (d.risk_flags||[]).length };
      } catch { return { fitness:"?", thesis:"?", risk:"?", flags:"?" }; }
    };

    const bf = extractFields(baselineStr, role.includes("analyst"));
    const nf = extractFields(j1, role.includes("analyst"));
    const df = extractFields(j2, role.includes("analyst"));

    // Extract ticker from user message
    const tickerMatch = trace.request.user_message.match(/(?:(?<=ticker|股票)[^A-Z]*)([A-Z0-9]{6,8})/);
    const ticker = tickerMatch ? tickerMatch[0].trim() : "?";

    console.log(`### ${role} (ticker: ${ticker})`);
    console.log(`| 指标 | trace (原始有disabled) | 本次无 thinking disabled | 本次有 thinking disabled |`);
    console.log(`|---|---|---|---|`);
    console.log(`| 耗时 | ${trace.meta.duration_ms}ms | ${r1.durationMs}ms | ${r2.durationMs}ms |`);
    console.log(`| JSON 一致 | - | ${same1} | ${same2} |`);

    if (role.includes("analyst")) {
      console.log(`| fitness | ${bf.fitness} | ${nf.fitness} | ${df.fitness} |`);
      console.log(`| thesis | ${bf.thesis} | ${nf.thesis} | ${df.thesis} |`);
    } else {
      console.log(`| risk | ${bf.risk} | ${nf.risk} | ${df.risk} |`);
      console.log(`| flags | ${bf.flags} | ${nf.flags} | ${df.flags} |`);
    }
    console.log();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
