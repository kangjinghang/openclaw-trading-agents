// tests/ts/integration.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runQuickAnalysis, runFullAnalysis } from '../../src/orchestrator';
import { TradingAgentsConfig, QuickAnalysisResult } from '../../src/types';
import OpenAI from 'openai';
import { rm, mkdir, readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import * as os from 'os';

// Mock execPython at module level
vi.mock('../../src/exec-python', () => ({
  execPython: vi.fn(),
  resolvePythonCmd: vi.fn(() => 'python3'),
}));

import { execPython } from '../../src/exec-python';

/** Generate a mock LLM response for a given analyst role */
function mockAnalystResponse(role: string, direction: string, reason: string) {
  return {
    choices: [{
      message: {
        content: `${role} analyst report for test.\n\n<!-- VERDICT: {"direction": "${direction}", "reason": "${reason}"} -->`
      }
    }],
    usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 }
  };
}

/** Create a mock LLM create function that matches responses by phase */
function createMockLLM(
  analystDirection: string = '中性',
  analystReason: string = 'test reason',
  pmDirection: string = 'Buy',
  pmReason: string = '综合7位分析师意见'
) {
  return vi.fn(async (params: any) => {
    const systemPrompt = params.messages?.[0]?.content || '';
    const isAnalyst = !systemPrompt.includes('portfolio') && !systemPrompt.includes('manager');

    if (isAnalyst) {
      // Determine role from user message (includes "# A 股XXX分析师" header)
      const userMessage = params.messages?.[1]?.content || '';
      let role = 'market';
      if (userMessage.includes('基本面')) role = 'fundamentals';
      else if (userMessage.includes('新闻')) role = 'news';
      else if (userMessage.includes('情绪')) role = 'sentiment';
      else if (userMessage.includes('政策')) role = 'policy';
      else if (userMessage.includes('游资') || userMessage.includes('资金流')) role = 'hot_money';
      else if (userMessage.includes('解禁')) role = 'lockup';
      return mockAnalystResponse(role, analystDirection, analystReason);
    }

    // Portfolio manager / other roles
    return {
      choices: [{
        message: {
          content: `Portfolio decision based on 7 analysts.\n\n<!-- VERDICT: {"direction": "${pmDirection}", "reason": "${pmReason}"} -->`
        }
      }],
      usage: { prompt_tokens: 800, completion_tokens: 300, total_tokens: 1100 }
    };
  });
}

const ANALYST_ROLES = ['market', 'fundamentals', 'news', 'sentiment', 'policy', 'hot_money', 'lockup'];

describe('Integration Test: End-to-End Quick Analysis (7 Analysts)', { timeout: 15_000 }, () => {
  const tmpReportDir = join(process.cwd(), 'test-tmp-reports');
  const actualTraceDir = join(tmpReportDir, '600519', '2026-06-05_quick', '02_traces');
  const actualDataDir = join(tmpReportDir, '600519', '2026-06-05_quick', '03_data');

  let config: TradingAgentsConfig;
  let mockClient: OpenAI;

  beforeEach(async () => {
    await mkdir(tmpReportDir, { recursive: true });

    config = {
      models: {
        analyst: 'gpt-4o',
        debater: 'gpt-4o',
        decision: 'gpt-4o',
        risk: 'gpt-4o'
      },
      debate_rounds: 2,
      risk_debate_rounds: 1,
      max_risk_retries: 1,
  llm_concurrency: 3,
      report_dir: tmpReportDir,
    };

    mockClient = {
      chat: {
        completions: {
          create: vi.fn()
        }
      }
    } as any;
  });

  afterEach(async () => {
    await rm(tmpReportDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('should run quick analysis with 7 analysts end-to-end', async () => {
    // Mock execPython to return success for all scripts
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    // Custom mock: all analysts 中性 except hot_money=看多
    const mockCreate = vi.fn(async (params: any) => {
      const systemPrompt = params.messages?.[0]?.content || '';
      const userMessage = params.messages?.[1]?.content || '';
      const isAnalyst = !systemPrompt.includes('portfolio') && !systemPrompt.includes('manager');

      if (isAnalyst) {
        const isHotMoney = userMessage.includes('游资') || userMessage.includes('资金流');
        const direction = isHotMoney ? '看多' : '中性';
        const role = isHotMoney ? 'hot_money' : 'market';
        return mockAnalystResponse(role, direction, `${role} reason`);
      }

      return {
        choices: [{ message: { content: `Portfolio decision based on 7 analysts.\n\n<!-- VERDICT: {"direction": "Buy", "reason": "综合7位分析师意见"} -->` } }],
        usage: { prompt_tokens: 800, completion_tokens: 300, total_tokens: 1100 }
      };
    });
    mockClient.chat.completions.create = mockCreate;

    // Run the analysis
    const [result] = await runQuickAnalysis('600519', '2026-06-05', config, mockClient);

    // Verify result structure
    expect(result).toBeDefined();
    expect(result.ticker).toBe('600519');
    expect(result.mode).toBe('quick');
    expect(result.date).toBe('2026-06-05');

    // Verify 7 analyst reports
    expect(result.analysts).toBeDefined();
    expect(result.analysts).toHaveLength(7);

    const roles = result.analysts.map(a => a.role);
    expect(roles).toEqual(ANALYST_ROLES);

    // Verify each analyst has verdict
    for (const report of result.analysts) {
      expect(report.verdict).toBeDefined();
      expect(report.verdict.direction).toBeDefined();
      expect(report.verdict.reason).toBeDefined();
    }

    // Verify final decision
    expect(result.final).toBeDefined();
    expect(result.final.direction).toBe('Buy');
    expect(result.final.reasoning).toBe('综合7位分析师意见');

    // Verify all 7 analyst verdicts are in final decision
    expect(Object.keys(result.final.analyst_verdicts)).toHaveLength(7);
    expect(result.final.analyst_verdicts['hot_money']).toBe('看多');
    expect(result.final.analyst_verdicts['market']).toBe('中性');

    // Verify LLM calls: 7 analysts + 1 quality_review + 1 PM = 9
    expect(mockCreate).toHaveBeenCalledTimes(9);

    // Verify execPython was called for all 7 data scripts
    expect(execPython).toHaveBeenCalledTimes(7);

    // Verify report files were created
    const tickerDir = join(tmpReportDir, '600519');
    expect(existsSync(tickerDir)).toBe(true);

    const summaryFile = join(tickerDir, '2026-06-05_quick.json');
    expect(existsSync(summaryFile)).toBe(true);

    const summaryContent = JSON.parse(await readFile(summaryFile, 'utf-8'));
    expect(summaryContent.ticker).toBe('600519');
    expect(summaryContent.final.direction).toBe('Buy');

    // Verify trace files
    expect(existsSync(actualTraceDir)).toBe(true);
    const traceFiles = await readdir(actualTraceDir);
    expect(traceFiles.length).toBeGreaterThan(0);

    // Verify raw data files
    expect(existsSync(actualDataDir)).toBe(true);
    const dataFiles = await readdir(actualDataDir);
    expect(dataFiles.length).toBe(7);
    for (const role of ANALYST_ROLES) {
      expect(dataFiles).toContain(`${role}_raw.json`);
    }
  });

  it('should handle Chinese direction parsing correctly with 7 analysts', async () => {
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = createMockLLM('看多', '技术面向好', '买入', '建议买入');
    mockClient.chat.completions.create = mockCreate;

    const [result] = await runQuickAnalysis('600519', '2026-06-05', config, mockClient);

    expect(result.final.direction).toBe('Buy'); // '买入' maps to 'Buy'
    expect(result.analysts).toHaveLength(7);
    // All analysts should have 看多 direction
    for (const report of result.analysts) {
      expect(report.verdict.direction).toBe('看多');
    }
  });

  it('should gracefully degrade when some data scripts fail', async () => {
    // Some scripts succeed, some fail
    vi.mocked(execPython).mockImplementation(async (scriptPath: string) => {
      if (scriptPath.includes('trading-kline')) {
        return { success: true, data: { ticker: '600519', data: [] } };
      }
      if (scriptPath.includes('trading-news')) {
        return { success: true, data: { ticker: '600519', news: [] } };
      }
      return { success: false, error: 'Script failed' };
    });

    const mockCreate = createMockLLM('中性', 'partial data', 'Hold', '继续持有');
    mockClient.chat.completions.create = mockCreate;

    const [result] = await runQuickAnalysis('600519', '2026-06-05', config, mockClient);

    // Should still produce 7 analyst reports (with degraded data)
    expect(result.analysts).toHaveLength(7);
    expect(result.final.direction).toBe('Hold');
  });

  it('should abort the pipeline when a majority of data sources fail', async () => {
    // 6 of 7 scripts fail → crosses the data_collection abort gate (≥6 failed).
    // Previously the pipeline kept running PM on an empty analyst set, wasting
    // LLM budget and writing a useless "0 analysts" report. It must now throw
    // EnvironmentError before any LLM call.
    vi.mocked(execPython).mockImplementation(async (scriptPath: string) => {
      if (scriptPath.includes('trading-fundamentals')) {
        return { success: true, data: { ticker: '600519', valuation: { name: '测试' } } };
      }
      return { success: false, error: 'Script failed' };
    });

    const mockCreate = createMockLLM('看多', 'should not run', 'Buy', 'should not run');
    mockClient.chat.completions.create = mockCreate;

    await expect(
      runQuickAnalysis('600519', '2026-06-05', config, mockClient)
    ).rejects.toThrow(/管道中止/);
    // PM (and every downstream LLM call) must have been skipped.
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('should handle Hold direction', async () => {
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = createMockLLM('中性', '观望', '持有', '继续持有');
    mockClient.chat.completions.create = mockCreate;

    const [result] = await runQuickAnalysis('600519', '2026-06-05', config, mockClient);
    expect(result.final.direction).toBe('Hold');
  });

  it('should run full analysis with debate → research → trader → risk', async () => {
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = vi.fn();
    let debateCallIdx = 0;

    mockCreate.mockImplementation(async (params: any) => {
      const systemPrompt = params.messages?.[0]?.content || '';

      // Analysts (7 calls, parallel)
      if (!systemPrompt.includes('portfolio') && !systemPrompt.includes('manager') && !systemPrompt.includes('bullish') && !systemPrompt.includes('bearish') && !systemPrompt.includes('research') && !systemPrompt.includes('trader') && !systemPrompt.includes('risk')) {
        return mockAnalystResponse('market', '看多', 'market reason');
      }

      // Debate: bull or bear
      if (systemPrompt.includes('bullish')) {
        debateCallIdx++;
        return { choices: [{ message: { content: `BULL-${Math.ceil(debateCallIdx/2)} claim.\n\n### 论据总结\nBull summary\n\n<!-- VERDICT: {"direction": "看多", "reason": "bull"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 } };
      }
      if (systemPrompt.includes('bearish')) {
        return { choices: [{ message: { content: `BEAR claim.\n\n### 风险总结\nBear summary\n\n<!-- VERDICT: {"direction": "看空", "reason": "bear"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 } };
      }

      // Research Manager (check before trader, since trader SP includes "research decisions")
      if (systemPrompt.includes('research') && !systemPrompt.includes('trader')) {
        return { choices: [{ message: { content: `### 评分\n- **多头得分**：70\n- **空头得分**：40\n\n### 关键辩论焦点\n1. 政策利好\n\n### 最终决策\n- **方向**：Overweight\n- **信心水平**：0.75\n\n<!-- VERDICT: {"direction": "Overweight", "reason": "bull wins"} -->` } }], usage: { prompt_tokens: 1000, completion_tokens: 400, total_tokens: 1400 } };
      }

      // Trader (must come before general 'research' check)
      if (systemPrompt.includes('trader')) {
        return { choices: [{ message: { content: `### 交易方向与仓位\n- **建议仓位**：25%\n\n### 价格区间\n- **目标价格**：1400 元\n- **止损价格**：1200 元\n\n### 入场信号\n1. 价格回调到1280\n\n### 退出信号\n1. 跌破1200\n\n### T+1 操作约束说明\nT+1制度\n\n### 关键风险提示\n1. 政策风险\n\n<!-- VERDICT: {"direction": "Buy", "reason": "分批建仓"} -->` } }], usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 } };
      }

      // Risk Debate (3 parallel)
      if (systemPrompt.includes('risk assessor')) {
        return { choices: [{ message: { content: `### 1. 立场声明\n支持\n\n### 2. 证据支撑\n- 证据1\n\n### 3. 风险评估结论\n- **verdict**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "ok"} -->` } }], usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 } };
      }

      // Risk Manager
      if (systemPrompt.includes('risk manager')) {
        return { choices: [{ message: { content: `### 1. 风险评分（0-100）\n35\n\n### 2. 风控决策\n- **status**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "risk ok"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 200, total_tokens: 800 } };
      }

      // Fallback
      return { choices: [{ message: { content: `<!-- VERDICT: {"direction": "Hold", "reason": "fallback"} -->` } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
    });

    mockClient.chat.completions.create = mockCreate;

    const [result] = await runFullAnalysis('600519', '2026-06-05', config, mockClient);

    expect(result.mode).toBe('full');
    expect(result.analysts).toHaveLength(7);
    expect(result.debate.rounds).toHaveLength(2);
    expect(result.research_decision.direction).toBe('Overweight');
    expect(result.trading_plan.target_price).toBe(1400);
    expect(result.risk_assessment.status).toBe('pass');

    // Total LLM calls: 7 analysts + 1 quality_review + 4 debate + 1 research + 1 trader + 3 risk + 1 risk_mgr = 18
    expect(mockCreate).toHaveBeenCalledTimes(18);

    // Verify report files
    const summaryFile = join(tmpReportDir, '600519', '2026-06-05_full.json');
    expect(existsSync(summaryFile)).toBe(true);

    const detailDir = join(tmpReportDir, '600519', '2026-06-05_full');
    expect(existsSync(join(detailDir, '02_debate', 'round_1.json'))).toBe(true);
    expect(existsSync(join(detailDir, '03_research.json'))).toBe(true);
    expect(existsSync(join(detailDir, '04_trading_plan.json'))).toBe(true);
    expect(existsSync(join(detailDir, '05_risk', 'risk_manager.json'))).toBe(true);

    // Verify quality-gate output persisted (Layer-1 grades + Layer-2 review).
    // Previously this data was computed, injected into prompts, then discarded —
    // the only way to review it post-run was grepping trace prompt inputs.
    const qualityFile = join(detailDir, '00_quality.json');
    expect(existsSync(qualityFile)).toBe(true);
    const qualityData = JSON.parse(await readFile(qualityFile, 'utf-8'));
    expect(qualityData.layer1.grades).toHaveLength(7);  // 7 analysts graded
    expect(qualityData.layer1.summary_text).toBeTruthy();  // text injected into downstream prompts
    // layer2 is null when the mock LLM doesn't emit a QUALITY_REVIEW block, or a
    // review object when it does — either is valid, just check the field exists.
    expect(qualityData.layer2 === null || typeof qualityData.layer2 === 'object').toBe(true);

    // Verify human-readable report files auto-saved (review gap #2): the JSON
    // artifacts are for machines; report.md / report.html give a ready-to-read
    // narrative without re-running the CLI formatter.
    const reportMd = join(detailDir, 'report.md');
    const reportHtml = join(detailDir, 'report.html');
    expect(existsSync(reportMd)).toBe(true);
    expect(existsSync(reportHtml)).toBe(true);
    const mdContent = await readFile(reportMd, 'utf-8');
    expect(mdContent).toContain('#');  // has markdown headings
    const htmlContent = await readFile(reportHtml, 'utf-8');
    expect(htmlContent).toContain('<html');

    // Verify traces in report directory
    const fullTraceDir = join(detailDir, '06_traces');
    expect(existsSync(fullTraceDir)).toBe(true);
    const fullTraceFiles = await readdir(fullTraceDir);
    expect(fullTraceFiles.length).toBeGreaterThan(0);

    // Verify raw data in report directory
    const fullDataDir = join(detailDir, '07_data');
    expect(existsSync(fullDataDir)).toBe(true);
    const fullDataFiles = await readdir(fullDataDir);
    expect(fullDataFiles.length).toBe(7);
  });

  it('should keep status=revise and flag retries_exhausted when risk revise loop hits max retries', async () => {
    // Regression test for the force-pass-after-retries contradiction: previously
    // when risk_manager kept returning "revise" past max_risk_retries, the
    // orchestrator silently overrode status to "pass" while leaving the nested
    // judge object (still saying revise) and reasoning ("禁止当日建仓...")
    // untouched — producing a self-contradictory report. Fix: keep status
    // honest ("revise") and set a retries_exhausted flag.
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = vi.fn();
    let debateCallIdx = 0;

    mockCreate.mockImplementation(async (params: any) => {
      const systemPrompt = params.messages?.[0]?.content || '';

      // Analysts (7 calls, parallel)
      if (!systemPrompt.includes('portfolio') && !systemPrompt.includes('manager') && !systemPrompt.includes('bullish') && !systemPrompt.includes('bearish') && !systemPrompt.includes('research') && !systemPrompt.includes('trader') && !systemPrompt.includes('risk')) {
        return mockAnalystResponse('market', '看多', 'market reason');
      }

      if (systemPrompt.includes('bullish')) {
        debateCallIdx++;
        return { choices: [{ message: { content: `BULL-${Math.ceil(debateCallIdx/2)} claim.\n\n### 论据总结\nBull summary\n\n<!-- VERDICT: {"direction": "看多", "reason": "bull"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 } };
      }
      if (systemPrompt.includes('bearish')) {
        return { choices: [{ message: { content: `BEAR claim.\n\n### 风险总结\nBear summary\n\n<!-- VERDICT: {"direction": "看空", "reason": "bear"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 } };
      }

      if (systemPrompt.includes('research') && !systemPrompt.includes('trader')) {
        return { choices: [{ message: { content: `### 评分\n- **多头得分**：70\n- **空头得分**：40\n\n### 关键辩论焦点\n1. 政策利好\n\n### 最终决策\n- **方向**：Overweight\n- **信心水平**：0.75\n\n<!-- VERDICT: {"direction": "Overweight", "reason": "bull wins"} -->` } }], usage: { prompt_tokens: 1000, completion_tokens: 400, total_tokens: 1400 } };
      }

      if (systemPrompt.includes('trader')) {
        return { choices: [{ message: { content: `### 交易方向与仓位\n- **建议仓位**：25%\n\n### 价格区间\n- **目标价格**：1400 元\n- **止损价格**：1200 元\n\n<!-- VERDICT: {"direction": "Buy", "reason": "分批建仓"} -->` } }], usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 } };
      }

      if (systemPrompt.includes('risk assessor')) {
        return { choices: [{ message: { content: `### 1. 立场声明\n支持\n\n### 2. 证据支撑\n- 证据1\n\n### 3. 风险评估结论\n- **verdict**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "ok"} -->` } }], usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 } };
      }

      // Risk Manager — ALWAYS returns revise to drive the loop into the
      // retries-exhausted exit branch.
      if (systemPrompt.includes('risk manager')) {
        return { choices: [{ message: { content: `### 1. 风险评分（0-100）\n55\n\n### 2. 风控决策\n- **status**：revise\n\n<!-- VERDICT: {"direction": "revise", "reason": "仓位过高"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 200, total_tokens: 800 } };
      }

      return { choices: [{ message: { content: `<!-- VERDICT: {"direction": "Hold", "reason": "fallback"} -->` } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
    });

    mockClient.chat.completions.create = mockCreate;

    const [result] = await runFullAnalysis('600519', '2026-06-05', config, mockClient);

    // After max_risk_retries (=1) the loop exits with status STILL revise.
    // The fix must NOT silently flip this to "pass" — that produced a
    // self-contradictory report (status=pass but judge.verdict=revise and
    // reasoning="禁止当日建仓..."). Keep the honest verdict.
    expect(result.risk_assessment.status).toBe('revise');
    // And flag that we gave up revising, so consumers can render this
    // distinctly from a clean pass.
    expect(result.risk_assessment.retries_exhausted).toBe(true);
    // final.risk_assessment propagates from riskAssessment.status — must
    // also stay revise so the dashboard badge reflects the real verdict.
    expect(result.final.risk_assessment).toBe('revise');

    // Call count: 18 (first pass) + 5 (1 trader + 3 risk_debate + 1 risk_mgr
    // on the single revise retry) = 23.
    expect(mockCreate).toHaveBeenCalledTimes(23);
  });

  it('should cap final position_pct to the risk manager hard-constraint cap', async () => {
    // Regression for 600600: risk_manager emitted "总仓位≤10%" as a
    // hard_constraint but max_position_override was never populated, so the
    // orchestrator's numeric cap never fired and the trader's 15% plan stood.
    // Fix: runRiskManager extracts the cap from hard_constraints text, and the
    // orchestrator applies it AFTER the loop (final assessment binds final plan).
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = vi.fn();
    let debateCallIdx = 0;

    mockCreate.mockImplementation(async (params: any) => {
      const systemPrompt = params.messages?.[0]?.content || '';

      if (!systemPrompt.includes('portfolio') && !systemPrompt.includes('manager') && !systemPrompt.includes('bullish') && !systemPrompt.includes('bearish') && !systemPrompt.includes('research') && !systemPrompt.includes('trader') && !systemPrompt.includes('risk')) {
        return mockAnalystResponse('market', '看多', 'market reason');
      }
      if (systemPrompt.includes('bullish')) {
        debateCallIdx++;
        return { choices: [{ message: { content: `BULL-${Math.ceil(debateCallIdx/2)} claim.\n\n<!-- VERDICT: {"direction": "看多", "reason": "bull"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 } };
      }
      if (systemPrompt.includes('bearish')) {
        return { choices: [{ message: { content: `BEAR claim.\n\n<!-- VERDICT: {"direction": "看空", "reason": "bear"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 } };
      }
      if (systemPrompt.includes('research') && !systemPrompt.includes('trader')) {
        return { choices: [{ message: { content: `### 评分\n- **多头得分**：70\n- **空头得分**：40\n\n### 最终决策\n- **方向**：Overweight\n- **信心水平**：0.75\n\n<!-- VERDICT: {"direction": "Overweight", "reason": "bull wins"} -->` } }], usage: { prompt_tokens: 1000, completion_tokens: 400, total_tokens: 1400 } };
      }
      // Trader returns 25% — exceeds the risk cap, must be capped downstream.
      if (systemPrompt.includes('trader')) {
        return { choices: [{ message: { content: `### 交易方向与仓位\n- **建议仓位**：25%\n\n### 价格区间\n- **目标价格**：1400 元\n- **止损价格**：1200 元\n\n<!-- VERDICT: {"direction": "Buy", "reason": "分批建仓"} -->` } }], usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 } };
      }
      if (systemPrompt.includes('risk assessor')) {
        return { choices: [{ message: { content: `<!-- VERDICT: {"direction": "pass", "reason": "ok"} -->` } }], usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 } };
      }
      // Risk Manager: PASS but with a hard cap of 10% — the bug was that this
      // cap lived only in text and never reached the numeric enforcement path.
      if (systemPrompt.includes('risk manager')) {
        return { choices: [{ message: { content: `### 1. 风险评分（0-100）\n30\n\n### 2. 风控决策\n- **status**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "risk ok"} -->\n<!-- RISK_JUDGE: {"verdict": "pass", "reason": "通过但需控仓位", "hard_constraints": ["总仓位≤10%", "止损价≥1200元"], "soft_constraints": [], "execution_preconditions": [], "de_risk_triggers": []} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 200, total_tokens: 800 } };
      }

      return { choices: [{ message: { content: `<!-- VERDICT: {"direction": "Hold", "reason": "fallback"} -->` } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
    });

    mockClient.chat.completions.create = mockCreate;

    const [result] = await runFullAnalysis('600519', '2026-06-05', config, mockClient);

    // Trader said 25%, risk_manager capped at 10% → final must be 10, not 25.
    expect(result.trading_plan.position_pct).toBe(10);
    expect(result.final.position_pct).toBe(10);
    // And the cap was extracted onto the assessment.
    expect(result.risk_assessment.max_position_override).toBe(10);
  });

  it('should enforce stop_loss from risk hard_constraints', async () => {
    // When risk_manager says "止损价≥5.70元" but trader keeps producing
    // stop_loss=5.50, the orchestrator must clamp it outside the revise loop.
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = vi.fn();
    let debateCallIdx = 0;

    mockCreate.mockImplementation(async (params: any) => {
      const systemPrompt = params.messages?.[0]?.content || '';

      if (!systemPrompt.includes('portfolio') && !systemPrompt.includes('manager') && !systemPrompt.includes('bullish') && !systemPrompt.includes('bearish') && !systemPrompt.includes('research') && !systemPrompt.includes('trader') && !systemPrompt.includes('risk')) {
        return mockAnalystResponse('market', '看多', 'market reason');
      }
      if (systemPrompt.includes('bullish')) {
        debateCallIdx++;
        return { choices: [{ message: { content: `BULL-${Math.ceil(debateCallIdx/2)} claim.\n\n<!-- VERDICT: {"direction": "看多", "reason": "bull"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 } };
      }
      if (systemPrompt.includes('bearish')) {
        return { choices: [{ message: { content: `BEAR claim.\n\n<!-- VERDICT: {"direction": "看空", "reason": "bear"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 } };
      }
      if (systemPrompt.includes('research') && !systemPrompt.includes('trader')) {
        return { choices: [{ message: { content: `### 评分\n- **多头得分**：70\n- **空头得分**：40\n\n### 最终决策\n- **方向**：Overweight\n- **信心水平**：0.75\n\n<!-- VERDICT: {"direction": "Overweight", "reason": "bull wins"} -->` } }], usage: { prompt_tokens: 1000, completion_tokens: 400, total_tokens: 1400 } };
      }
      // Trader returns stop_loss=5.50, below the risk cap of 5.70.
      if (systemPrompt.includes('trader')) {
        return { choices: [{ message: { content: `### 交易方向与仓位\n- **建议仓位**：20%\n\n### 价格区间\n- **目标价格**：6.50 元\n- **止损价格**：5.50 元\n\n<!-- VERDICT: {"direction": "Buy", "reason": "分批建仓"} -->` } }], usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 } };
      }
      if (systemPrompt.includes('risk assessor')) {
        return { choices: [{ message: { content: `<!-- VERDICT: {"direction": "pass", "reason": "ok"} -->` } }], usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 } };
      }
      // Risk Manager: PASS but with hard constraint stop_loss >= 5.70
      if (systemPrompt.includes('risk manager')) {
        return { choices: [{ message: { content: `### 1. 风险评分（0-100）\n30\n\n### 2. 风控决策\n- **status**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "risk ok"} -->\n<!-- RISK_JUDGE: {"verdict": "pass", "reason": "通过但止损过低", "hard_constraints": ["止损价≥5.70元"], "soft_constraints": [], "execution_preconditions": [], "de_risk_triggers": []} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 200, total_tokens: 800 } };
      }

      return { choices: [{ message: { content: `<!-- VERDICT: {"direction": "Hold", "reason": "fallback"} -->` } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
    });

    mockClient.chat.completions.create = mockCreate;

    const [result] = await runFullAnalysis('600519', '2026-06-05', config, mockClient);

    // Trader said 5.50, risk_manager required >= 5.70 → final must be 5.70.
    expect(result.trading_plan.stop_loss).toBeGreaterThanOrEqual(5.70);
    // Also verify the position cap test wasn't broken — position should be 20 (no cap here).
    expect(result.trading_plan.position_pct).toBe(20);
  });

  it('should handle pipe-separated VERDICT direction by taking first option', async () => {
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = createMockLLM('看多|看空|中性', 'test fallback', 'Buy|Hold|Sell', '综合判断');
    mockClient.chat.completions.create = mockCreate;

    const [result] = await runQuickAnalysis('600519', '2026-06-05', config, mockClient);

    // parseDirection takes the first option from pipe-separated values
    expect(result.final.direction).toBe('Buy'); // "Buy|Hold|Sell" → first = "Buy"
    expect(result.analysts).toHaveLength(7);
    // Each analyst verdict should have the raw pipe-separated value
    for (const report of result.analysts) {
      expect(report.verdict.direction).toBe('看多|看空|中性');
    }
  });

  it('should degrade gracefully when portfolio manager verdict parsing fails', async () => {
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = vi.fn(async (params: any) => {
      const systemPrompt = params.messages?.[0]?.content || '';
      const isAnalyst = !systemPrompt.includes('portfolio') && !systemPrompt.includes('manager');

      if (isAnalyst) {
        // 5 看多, 2 中性 → majority = 看多
        const userMessage = params.messages?.[1]?.content || '';
        const isFundOrHotMoney = userMessage.includes('基本面') || userMessage.includes('游资');
        const direction = isFundOrHotMoney ? '中性' : '看多';
        return mockAnalystResponse('market', direction, `${direction} reason`);
      }

      // Portfolio manager returns content WITHOUT VERDICT
      return {
        choices: [{ message: { content: 'I have analyzed the reports but cannot reach a clear conclusion.' } }],
        usage: { prompt_tokens: 800, completion_tokens: 300, total_tokens: 1100 }
      };
    });
    mockClient.chat.completions.create = mockCreate;

    const [result] = await runQuickAnalysis('600519', '2026-06-05', config, mockClient);

    // Should NOT throw — degrades to analyst majority vote
    expect(result.final.direction).toBe('Buy'); // 看多 → Buy (majority of 7 analysts)
    expect(result.final.reasoning).toContain('分析师多数意见');
    expect(result.analysts).toHaveLength(7);
  });

  it('should emit overall-progress with monotonic percentages reaching 100 in quick mode', async () => {
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = createMockLLM('中性', 'test reason', 'Buy', '综合意见');
    mockClient.chat.completions.create = mockCreate;

    const progressMsgs: { text: string; id?: string }[] = [];
    const onProgress = (text: string, id?: string) => progressMsgs.push({ text, id });
    await runQuickAnalysis('600519', '2026-06-05', config, mockClient, undefined, onProgress);

    const overall = progressMsgs.filter(p => p.id === 'overall-progress');
    expect(overall.length).toBeGreaterThan(0);
    const pcts = overall.map(p => {
      const m = p.text.match(/(\d+)%/);
      return m ? parseInt(m[1], 10) : -1;
    });
    // monotonic non-decreasing
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
    }
    // ends at 100 (save stage)
    expect(pcts[pcts.length - 1]).toBe(100);
    // analysts phase advanced at least once (>=7 emits: data + 7 analysts + pm + save)
    expect(overall.length).toBeGreaterThanOrEqual(7);
  });

  it('should include decision_rationale in full analysis result', async () => {
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = vi.fn();
    let debateCallIdx = 0;

    mockCreate.mockImplementation(async (params: any) => {
      const systemPrompt = params.messages?.[0]?.content || '';

      // Analysts
      if (!systemPrompt.includes('portfolio') && !systemPrompt.includes('manager') && !systemPrompt.includes('bullish') && !systemPrompt.includes('bearish') && !systemPrompt.includes('research') && !systemPrompt.includes('trader') && !systemPrompt.includes('risk')) {
        return mockAnalystResponse('market', '看多', 'market reason');
      }

      if (systemPrompt.includes('bullish')) {
        debateCallIdx++;
        return { choices: [{ message: { content: `BULL-${Math.ceil(debateCallIdx/2)} claim.\n\n### 论据总结\nBull summary\n\n<!-- VERDICT: {"direction": "看多", "reason": "bull"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 } };
      }
      if (systemPrompt.includes('bearish')) {
        return { choices: [{ message: { content: `BEAR claim.\n\n### 风险总结\nBear summary\n\n<!-- VERDICT: {"direction": "看空", "reason": "bear"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 } };
      }

      if (systemPrompt.includes('research') && !systemPrompt.includes('trader')) {
        return { choices: [{ message: { content: `### 评分\n- **多头得分**：70\n- **空头得分**：40\n\n### 关键辩论焦点\n1. 政策利好\n\n### 最终决策\n- **方向**：Overweight\n- **信心水平**：0.75\n\n<!-- VERDICT: {"direction": "Overweight", "reason": "bull wins"} -->` } }], usage: { prompt_tokens: 1000, completion_tokens: 400, total_tokens: 1400 } };
      }

      if (systemPrompt.includes('trader')) {
        return { choices: [{ message: { content: `### 交易方向与仓位\n- **建议仓位**：25%\n\n### 价格区间\n- **目标价格**：1400 元\n- **止损价格**：1200 元\n\n### T+1 操作约束说明\nT+1制度\n\n### 关键风险提示\n1. 政策风险\n\n<!-- VERDICT: {"direction": "Buy", "reason": "分批建仓"} -->` } }], usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 } };
      }

      if (systemPrompt.includes('risk assessor')) {
        return { choices: [{ message: { content: `### 1. 立场声明\n支持\n\n### 2. 证据支撑\n- 证据1\n\n### 3. 风险评估结论\n- **verdict**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "ok"} -->` } }], usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 } };
      }

      if (systemPrompt.includes('risk manager')) {
        return { choices: [{ message: { content: `### 1. 风险评分（0-100）\n35\n\n### 2. 风控决策\n- **status**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "risk ok"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 200, total_tokens: 800 } };
      }

      return { choices: [{ message: { content: `<!-- VERDICT: {"direction": "Hold", "reason": "fallback"} -->` } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
    });

    mockClient.chat.completions.create = mockCreate;

    const [result] = await runFullAnalysis('600519', '2026-06-05', config, mockClient);

    expect(result.final.decision_rationale).toBeDefined();
    expect(typeof result.final.decision_rationale).toBe("string");
    expect(result.final.decision_rationale!.length).toBeGreaterThan(0);
    // Should contain analyst consensus info
    expect(result.final.decision_rationale).toContain('分析师共识');
    // Should contain debate scores
    expect(result.final.decision_rationale).toContain('多空辩论');
  });

  it('should register health warning when debate diverges (low convergence_score)', async () => {
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = vi.fn();

    // Build DEBATE_STATE blocks that produce unresolved claims but no resolved ones
    const bullDebateState1 = JSON.stringify({
      responded_claim_ids: [],
      new_claims: [
        { claim: "盈利增长", evidence: ["Q1利润+20%"], confidence: 0.8 },
        { claim: "政策利好", evidence: ["减税"], confidence: 0.7 }
      ],
      resolved_claim_ids: [],
      unresolved_claim_ids: [],
      next_focus_claim_ids: [],
      round_summary: "Bull round 1",
      round_goal: "Establish bull case"
    });
    // Bear marks bull claims as unresolved, adds own
    const bearDebateState1 = JSON.stringify({
      responded_claim_ids: ["BULL-1", "BULL-2"],
      new_claims: [
        { claim: "估值偏高", evidence: ["PE=50"], confidence: 0.6 }
      ],
      resolved_claim_ids: [],
      unresolved_claim_ids: ["BULL-1", "BULL-2"],
      next_focus_claim_ids: ["BULL-1"],
      round_summary: "Bear round 1 — unresolved",
      round_goal: "Challenge bull claims"
    });
    // Round 2: more unresolved
    const bullDebateState2 = JSON.stringify({
      responded_claim_ids: ["BEAR-1"],
      new_claims: [],
      resolved_claim_ids: [],
      unresolved_claim_ids: ["BEAR-1"],
      next_focus_claim_ids: [],
      round_summary: "Bull round 2",
      round_goal: "Rebuttal"
    });
    const bearDebateState2 = JSON.stringify({
      responded_claim_ids: [],
      new_claims: [],
      resolved_claim_ids: [],
      unresolved_claim_ids: ["BULL-1", "BULL-2"],
      next_focus_claim_ids: [],
      round_summary: "Bear round 2 — still unresolved",
      round_goal: "Final rebuttal"
    });

    mockCreate.mockImplementation(async (params: any) => {
      const systemPrompt = params.messages?.[0]?.content || '';

      // Analysts (7 calls, parallel)
      if (!systemPrompt.includes('portfolio') && !systemPrompt.includes('manager') && !systemPrompt.includes('bullish') && !systemPrompt.includes('bearish') && !systemPrompt.includes('research') && !systemPrompt.includes('trader') && !systemPrompt.includes('risk')) {
        return mockAnalystResponse('market', '看多', 'market reason');
      }

      // Debate: bull or bear — emit DEBATE_STATE blocks
      if (systemPrompt.includes('bullish')) {
        const userMsg = params.messages?.[1]?.content || '';
        const isRound2 = userMsg.includes('round 2') || userMsg.includes('Round 2') || userMsg.includes('第 2 轮') || userMsg.includes('第2轮');
        const state = isRound2 ? bullDebateState2 : bullDebateState1;
        return { choices: [{ message: { content: `Bull argument.\n\n### 论据总结\nBull summary\n\n<!-- DEBATE_STATE: ${state} -->\n\n<!-- VERDICT: {"direction": "看多", "reason": "bull"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 } };
      }
      if (systemPrompt.includes('bearish')) {
        const userMsg = params.messages?.[1]?.content || '';
        const isRound2 = userMsg.includes('round 2') || userMsg.includes('Round 2') || userMsg.includes('第 2 轮') || userMsg.includes('第2轮');
        const state = isRound2 ? bearDebateState2 : bearDebateState1;
        return { choices: [{ message: { content: `Bear counter.\n\n### 风险总结\nBear summary\n\n<!-- DEBATE_STATE: ${state} -->\n\n<!-- VERDICT: {"direction": "看空", "reason": "bear"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 } };
      }

      // Research Manager
      if (systemPrompt.includes('research') && !systemPrompt.includes('trader')) {
        return { choices: [{ message: { content: `### 评分\n- **多头得分**：60\n- **空头得分**：50\n\n### 关键辩论焦点\n1. 估值分歧\n\n### 最终决策\n- **方向**：Hold\n- **信心水平**：0.5\n\n<!-- VERDICT: {"direction": "Hold", "reason": "分歧大"} -->` } }], usage: { prompt_tokens: 1000, completion_tokens: 400, total_tokens: 1400 } };
      }

      // Trader
      if (systemPrompt.includes('trader')) {
        return { choices: [{ message: { content: `### 交易方向与仓位\n- **建议仓位**：10%\n\n### 价格区间\n- **目标价格**：1400 元\n- **止损价格**：1200 元\n\n### T+1 操作约束说明\nT+1制度\n\n### 关键风险提示\n1. 政策风险\n\n<!-- VERDICT: {"direction": "Hold", "reason": "观望"} -->` } }], usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 } };
      }

      // Risk Debate (3 parallel)
      if (systemPrompt.includes('risk assessor')) {
        return { choices: [{ message: { content: `### 1. 立场声明\n支持\n\n### 2. 证据支撑\n- 证据1\n\n### 3. 风险评估结论\n- **verdict**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "ok"} -->` } }], usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 } };
      }

      // Risk Manager
      if (systemPrompt.includes('risk manager')) {
        return { choices: [{ message: { content: `### 1. 风险评分（0-100）\n35\n\n### 2. 风控决策\n- **status**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "risk ok"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 200, total_tokens: 800 } };
      }

      return { choices: [{ message: { content: `<!-- VERDICT: {"direction": "Hold", "reason": "fallback"} -->` } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
    });

    mockClient.chat.completions.create = mockCreate;

    const [result, runMeta] = await runFullAnalysis('600519', '2026-06-05', config, mockClient);

    // The debate should have a low convergence_score (< 0.5) because all claims are unresolved
    expect(result.debate.convergence_score).toBeLessThan(0.5);

    // Pipeline health should contain a debate-stage warning
    expect(runMeta.pipeline_health).toBeDefined();
    const debateIssues = (runMeta.pipeline_health || []).filter(
      (issue: any) => issue.stage === "debate" && issue.check === "debate_divergence"
    );
    expect(debateIssues.length).toBeGreaterThanOrEqual(1);
    expect(debateIssues[0].severity).toBe("warn");
    expect(debateIssues[0].message).toContain("收敛分数偏低");
  });

  it('should emit overall-progress with monotonic percentages reaching 100 in full mode', async () => {
    // Reuse the SAME mock LLM pattern as 'should run full analysis with debate → research → trader → risk'
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = vi.fn();
    let debateCallIdx = 0;

    mockCreate.mockImplementation(async (params: any) => {
      const systemPrompt = params.messages?.[0]?.content || '';

      // Analysts (7 calls, parallel)
      if (!systemPrompt.includes('portfolio') && !systemPrompt.includes('manager') && !systemPrompt.includes('bullish') && !systemPrompt.includes('bearish') && !systemPrompt.includes('research') && !systemPrompt.includes('trader') && !systemPrompt.includes('risk')) {
        return mockAnalystResponse('market', '看多', 'market reason');
      }

      // Debate: bull or bear
      if (systemPrompt.includes('bullish')) {
        debateCallIdx++;
        return { choices: [{ message: { content: `BULL-${Math.ceil(debateCallIdx/2)} claim.\n\n### 论据总结\nBull summary\n\n<!-- VERDICT: {"direction": "看多", "reason": "bull"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 } };
      }
      if (systemPrompt.includes('bearish')) {
        return { choices: [{ message: { content: `BEAR claim.\n\n### 风险总结\nBear summary\n\n<!-- VERDICT: {"direction": "看空", "reason": "bear"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 } };
      }

      // Research Manager
      if (systemPrompt.includes('research') && !systemPrompt.includes('trader')) {
        return { choices: [{ message: { content: `### 评分\n- **多头得分**：70\n- **空头得分**：40\n\n### 关键辩论焦点\n1. 政策利好\n\n### 最终决策\n- **方向**：Overweight\n- **信心水平**：0.75\n\n<!-- VERDICT: {"direction": "Overweight", "reason": "bull wins"} -->` } }], usage: { prompt_tokens: 1000, completion_tokens: 400, total_tokens: 1400 } };
      }

      // Trader
      if (systemPrompt.includes('trader')) {
        return { choices: [{ message: { content: `### 交易方向与仓位\n- **建议仓位**：25%\n\n### 价格区间\n- **目标价格**：1400 元\n- **止损价格**：1200 元\n\n### 入场信号\n1. 价格回调到1280\n\n### 退出信号\n1. 跌破1200\n\n### T+1 操作约束说明\nT+1制度\n\n### 关键风险提示\n1. 政策风险\n\n<!-- VERDICT: {"direction": "Buy", "reason": "分批建仓"} -->` } }], usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 } };
      }

      // Risk Debate (3 parallel)
      if (systemPrompt.includes('risk assessor')) {
        return { choices: [{ message: { content: `### 1. 立场声明\n支持\n\n### 2. 证据支撑\n- 证据1\n\n### 3. 风险评估结论\n- **verdict**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "ok"} -->` } }], usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 } };
      }

      // Risk Manager
      if (systemPrompt.includes('risk manager')) {
        return { choices: [{ message: { content: `### 1. 风险评分（0-100）\n35\n\n### 2. 风控决策\n- **status**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "risk ok"} -->` } }], usage: { prompt_tokens: 600, completion_tokens: 200, total_tokens: 800 } };
      }

      // Fallback
      return { choices: [{ message: { content: `<!-- VERDICT: {"direction": "Hold", "reason": "fallback"} -->` } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
    });

    mockClient.chat.completions.create = mockCreate;

    const progressMsgs: { text: string; id?: string }[] = [];
    const onProgress = (text: string, id?: string) => progressMsgs.push({ text, id });
    await runFullAnalysis('600519', '2026-06-05', config, mockClient, undefined, onProgress);

    const overall = progressMsgs.filter(p => p.id === 'overall-progress');
    expect(overall.length).toBeGreaterThan(0);
    const pcts = overall.map(p => {
      const m = p.text.match(/(\d+)%/);
      return m ? parseInt(m[1], 10) : -1;
    });
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
    }
    expect(pcts[pcts.length - 1]).toBe(100);
  }, 30_000);
});
