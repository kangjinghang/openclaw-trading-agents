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
  execPython: vi.fn()
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

describe('Integration Test: End-to-End Quick Analysis (7 Analysts)', () => {
  const tmpReportDir = join(process.cwd(), 'test-tmp-reports');
  const actualTraceDir = join(os.homedir(), '.openclaw', 'traces', '600519_2026-06-05');

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
    await rm(actualTraceDir, { recursive: true, force: true });
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
    const result = await runQuickAnalysis('600519', '2026-06-05', config, mockClient);

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

    // Verify LLM calls: 7 analysts + 1 PM = 8
    expect(mockCreate).toHaveBeenCalledTimes(8);

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
  });

  it('should handle Chinese direction parsing correctly with 7 analysts', async () => {
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = createMockLLM('看多', '技术面向好', '买入', '建议买入');
    mockClient.chat.completions.create = mockCreate;

    const result = await runQuickAnalysis('600519', '2026-06-05', config, mockClient);

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

    const result = await runQuickAnalysis('600519', '2026-06-05', config, mockClient);

    // Should still produce 7 analyst reports (with degraded data)
    expect(result.analysts).toHaveLength(7);
    expect(result.final.direction).toBe('Hold');
  });

  it('should handle Hold direction', async () => {
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = createMockLLM('中性', '观望', '持有', '继续持有');
    mockClient.chat.completions.create = mockCreate;

    const result = await runQuickAnalysis('600519', '2026-06-05', config, mockClient);
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

    const result = await runFullAnalysis('600519', '2026-06-05', config, mockClient);

    expect(result.mode).toBe('full');
    expect(result.analysts).toHaveLength(7);
    expect(result.debate.rounds).toHaveLength(2);
    expect(result.research_decision.direction).toBe('Overweight');
    expect(result.trading_plan.target_price).toBe(1400);
    expect(result.risk_assessment.status).toBe('pass');

    // Total LLM calls: 7 analysts + 4 debate + 1 research + 1 trader + 3 risk + 1 risk_mgr = 17
    expect(mockCreate).toHaveBeenCalledTimes(17);

    // Verify report files
    const summaryFile = join(tmpReportDir, '600519', '2026-06-05_full.json');
    expect(existsSync(summaryFile)).toBe(true);

    const detailDir = join(tmpReportDir, '600519', '2026-06-05_full');
    expect(existsSync(join(detailDir, '02_debate', 'round_1.json'))).toBe(true);
    expect(existsSync(join(detailDir, '03_research.json'))).toBe(true);
    expect(existsSync(join(detailDir, '04_trading_plan.json'))).toBe(true);
    expect(existsSync(join(detailDir, '05_risk', 'risk_manager.json'))).toBe(true);
  });

  it('should handle pipe-separated VERDICT direction by taking first option', async () => {
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = createMockLLM('看多|看空|中性', 'test fallback', 'Buy|Hold|Sell', '综合判断');
    mockClient.chat.completions.create = mockCreate;

    const result = await runQuickAnalysis('600519', '2026-06-05', config, mockClient);

    // parseDirection takes the first option from pipe-separated values
    expect(result.final.direction).toBe('Buy'); // "Buy|Hold|Sell" → first = "Buy"
    expect(result.analysts).toHaveLength(7);
    // Each analyst verdict should have the raw pipe-separated value
    for (const report of result.analysts) {
      expect(report.verdict.direction).toBe('看多|看空|中性');
    }
  });
});
