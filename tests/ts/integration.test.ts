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

    const mockCreate = vi.mocked(mockClient.chat.completions.create);

    // 7 analyst responses
    for (const role of ANALYST_ROLES) {
      mockCreate.mockResolvedValueOnce(
        mockAnalystResponse(role, role === 'hot_money' ? '看多' : '中性', `${role} reason`) as any
      );
    }

    // 1 portfolio manager response
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: `Portfolio decision based on 7 analysts.

<!-- VERDICT: {"direction": "Buy", "reason": "综合7位分析师意见"} -->`
        }
      }],
      usage: { prompt_tokens: 800, completion_tokens: 300, total_tokens: 1100 }
    } as any);

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

    const mockCreate = vi.mocked(mockClient.chat.completions.create);

    // 7 analysts: all return 看多
    for (const role of ANALYST_ROLES) {
      mockCreate.mockResolvedValueOnce(
        mockAnalystResponse(role, '看多', '技术面向好') as any
      );
    }

    // PM returns 买入
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '决策 <!-- VERDICT: {"direction": "买入", "reason": "建议买入"} -->' } }],
      usage: { prompt_tokens: 800, completion_tokens: 300, total_tokens: 1100 }
    } as any);

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

    const mockCreate = vi.mocked(mockClient.chat.completions.create);

    // 7 analyst responses (all succeed even with partial data)
    for (const role of ANALYST_ROLES) {
      mockCreate.mockResolvedValueOnce(
        mockAnalystResponse(role, '中性', 'partial data') as any
      );
    }

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '决策 <!-- VERDICT: {"direction": "Hold", "reason": "继续持有"} -->' } }],
      usage: { prompt_tokens: 800, completion_tokens: 300, total_tokens: 1100 }
    } as any);

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

    const mockCreate = vi.mocked(mockClient.chat.completions.create);

    for (const role of ANALYST_ROLES) {
      mockCreate.mockResolvedValueOnce(
        mockAnalystResponse(role, '中性', '观望') as any
      );
    }

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '决策 <!-- VERDICT: {"direction": "持有", "reason": "继续持有"} -->' } }],
      usage: { prompt_tokens: 800, completion_tokens: 300, total_tokens: 1100 }
    } as any);

    const result = await runQuickAnalysis('600519', '2026-06-05', config, mockClient);
    expect(result.final.direction).toBe('Hold');
  });

  it('should run full analysis with debate → research → trader → risk', async () => {
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = vi.mocked(mockClient.chat.completions.create);

    // 7 analyst responses
    for (const role of ANALYST_ROLES) {
      mockCreate.mockResolvedValueOnce(
        mockAnalystResponse(role, '看多', `${role} reason`) as any
      );
    }

    // Debate: 2 rounds × 2 sides = 4 calls
    for (let round = 1; round <= 2; round++) {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: `BULL-${round} claim.\n\n### 论据总结\nBull summary round ${round}\n\n<!-- VERDICT: {"direction": "看多", "reason": "bull"} -->` } }],
        usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 }
      } as any);
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: `BEAR-${round} claim.\n\n### 风险总结\nBear summary round ${round}\n\n<!-- VERDICT: {"direction": "看空", "reason": "bear"} -->` } }],
        usage: { prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 }
      } as any);
    }

    // Research Manager
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: `### 评分\n- **多头得分**：70\n- **空头得分**：40\n\n### 关键辩论焦点\n1. 政策利好\n\n### 最终决策\n- **方向**：Overweight\n- **信心水平**：0.75\n\n<!-- VERDICT: {"direction": "Overweight", "reason": "bull wins"} -->` } }],
      usage: { prompt_tokens: 1000, completion_tokens: 400, total_tokens: 1400 }
    } as any);

    // Trader
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: `### 交易方向与仓位\n- **建议仓位**：25%\n\n### 价格区间\n- **目标价格**：1400 元\n- **止损价格**：1200 元\n\n### 入场信号\n1. 价格回调到1280\n\n### 退出信号\n1. 跌破1200\n\n### T+1 操作约束说明\nT+1制度\n\n### 关键风险提示\n1. 政策风险\n\n<!-- VERDICT: {"direction": "Buy", "reason": "分批建仓"} -->` } }],
      usage: { prompt_tokens: 800, completion_tokens: 400, total_tokens: 1200 }
    } as any);

    // Risk Debate: 3 parallel calls
    for (let i = 0; i < 3; i++) {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: `### 1. 立场声明\n支持\n\n### 2. 证据支撑\n- 证据${i}\n\n### 3. 风险评估结论\n- **verdict**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "ok"} -->` } }],
        usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 }
      } as any);
    }

    // Risk Manager
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: `### 1. 风险评分（0-100）\n35\n\n### 2. 风控决策\n- **status**：pass\n\n<!-- VERDICT: {"direction": "pass", "reason": "risk ok"} -->` } }],
      usage: { prompt_tokens: 600, completion_tokens: 200, total_tokens: 800 }
    } as any);

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

    const mockCreate = vi.mocked(mockClient.chat.completions.create);

    // Simulate a weak model that outputs pipe-separated direction despite the fix
    for (const role of ANALYST_ROLES) {
      mockCreate.mockResolvedValueOnce(
        mockAnalystResponse(role, '看多|看空|中性', `${role} fallback`) as any
      );
    }

    // PM also outputs pipe-separated
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '决策\n<!-- VERDICT: {"direction": "Buy|Hold|Sell", "reason": "综合判断"} -->' } }],
      usage: { prompt_tokens: 800, completion_tokens: 300, total_tokens: 1100 }
    } as any);

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
