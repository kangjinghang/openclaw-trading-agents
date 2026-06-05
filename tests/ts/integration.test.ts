// tests/ts/integration.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runQuickAnalysis } from '../../src/orchestrator';
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
});
