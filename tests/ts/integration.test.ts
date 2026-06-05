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

describe('Integration Test: End-to-End Quick Analysis', () => {
  const tmpReportDir = join(process.cwd(), 'test-tmp-reports');
  const actualTraceDir = join(os.homedir(), '.openclaw', 'traces', '600519_2026-06-05');

  let config: TradingAgentsConfig;
  let mockClient: OpenAI;

  beforeEach(async () => {
    // Create temp report directory
    await mkdir(tmpReportDir, { recursive: true });

    // Setup config
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

    // Create mock OpenAI client
    mockClient = {
      chat: {
        completions: {
          create: vi.fn()
        }
      }
    } as any;
  });

  afterEach(async () => {
    // Clean up temp directories
    await rm(tmpReportDir, { recursive: true, force: true });
    await rm(actualTraceDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('should run quick analysis end-to-end with mocked LLM responses', async () => {
    // Mock execPython to return dummy K-line data
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: {
        ticker: '600519',
        timeframe: '1d',
        data: [
          { date: '2026-06-01', open: 1800, close: 1820, high: 1830, low: 1790, volume: 1000000 },
          { date: '2026-06-02', open: 1820, close: 1840, high: 1850, low: 1810, volume: 1200000 },
          { date: '2026-06-03', open: 1840, close: 1860, high: 1870, low: 1830, volume: 1100000 },
        ]
      }
    });

    // Mock OpenAI client responses
    const mockCreate = vi.mocked(mockClient.chat.completions.create);

    // First call: market analyst response
    const analystResponse = {
      choices: [{
        message: {
          content: `Based on the K-line data analysis, I observe the following:

1. Price Trend: The stock has shown consistent upward momentum over the past 3 days
2. Volume Analysis: Trading volume has been healthy, indicating strong investor interest
3. Technical Indicators: MACD shows golden cross pattern with increasing volume

<!-- VERDICT: {"direction": "看多", "reason": "MACD金叉+放量突破"} -->`
        }
      }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500
      }
    };

    // Second call: portfolio manager response
    const portfolioResponse = {
      choices: [{
        message: {
          content: `After reviewing the market analyst's report, I make the following decision:

The technical analysis supports a bullish view with strong momentum indicators.

<!-- VERDICT: {"direction": "Buy", "reason": "技术面向好"} -->`
        }
      }],
      usage: {
        prompt_tokens: 800,
        completion_tokens: 300,
        total_tokens: 1100
      }
    };

    mockCreate
      .mockResolvedValueOnce(analystResponse as any)
      .mockResolvedValueOnce(portfolioResponse as any);

    // Run the analysis
    const result = await runQuickAnalysis('600519', '2026-06-05', config, mockClient);

    // Verify result structure
    expect(result).toBeDefined();
    expect(result.ticker).toBe('600519');
    expect(result.mode).toBe('quick');
    expect(result.date).toBe('2026-06-05');

    // Verify analyst report
    expect(result.analyst).toBeDefined();
    expect(result.analyst.role).toBe('market');
    expect(result.analyst.content).toContain('MACD金叉+放量突破');
    expect(result.analyst.verdict).toBeDefined();
    expect(result.analyst.verdict.direction).toBe('看多');
    expect(result.analyst.verdict.reason).toBe('MACD金叉+放量突破');
    expect(result.analyst.data_sources_used).toContain('K-line');

    // Verify final decision
    expect(result.final).toBeDefined();
    expect(result.final.ticker).toBe('600519');
    expect(result.final.date).toBe('2026-06-05');
    expect(result.final.direction).toBe('Buy'); // Should be parsed from 'Buy'
    expect(result.final.reasoning).toBe('技术面向好');
    expect(result.final.analyst_verdicts).toBeDefined();
    expect(result.final.analyst_verdicts['market']).toBe('看多');

    // Verify LLM calls were made correctly
    expect(mockCreate).toHaveBeenCalledTimes(2);

    // First call (analyst)
    const firstCall = mockCreate.mock.calls[0][0];
    expect(firstCall.model).toBe('gpt-4o');
    expect(firstCall.messages[0].role).toBe('system');
    expect(firstCall.messages[0].content).toContain('market analyst');
    expect(firstCall.temperature).toBe(0.4);
    expect(firstCall.max_tokens).toBe(4000);

    // Second call (portfolio manager)
    const secondCall = mockCreate.mock.calls[1][0];
    expect(secondCall.model).toBe('gpt-4o');
    expect(secondCall.messages[0].role).toBe('system');
    expect(secondCall.messages[0].content).toContain('portfolio manager');
    expect(secondCall.temperature).toBe(0.3);
    expect(secondCall.max_tokens).toBe(4000);

    // Verify report files were created
    const tickerDir = join(tmpReportDir, '600519');
    expect(existsSync(tickerDir)).toBe(true);

    // Check for summary JSON file
    const summaryFile = join(tickerDir, '2026-06-05_quick.json');
    expect(existsSync(summaryFile)).toBe(true);

    const summaryContent = JSON.parse(await readFile(summaryFile, 'utf-8'));
    expect(summaryContent.ticker).toBe('600519');
    expect(summaryContent.mode).toBe('quick');
    expect(summaryContent.final.direction).toBe('Buy');

    // Check for analyst detail file
    const detailDir = join(tickerDir, '2026-06-05_quick', '01_analysts');
    const analystFile = join(detailDir, 'market.json');
    expect(existsSync(analystFile)).toBe(true);

    const analystContent = JSON.parse(await readFile(analystFile, 'utf-8'));
    expect(analystContent.role).toBe('market');
    expect(analystContent.verdict.direction).toBe('看多');

    // Verify trace files were created
    expect(existsSync(actualTraceDir)).toBe(true);
    const traceFiles = await readdir(actualTraceDir);
    expect(traceFiles.length).toBeGreaterThan(0);

    // Verify trace file structure
    const traceFile = join(actualTraceDir, traceFiles[0]);
    const traceContent = JSON.parse(await readFile(traceFile, 'utf-8'));
    expect(traceContent.phase).toBeDefined();
    expect(traceContent.role).toBeDefined();
    expect(traceContent.request).toBeDefined();
    expect(traceContent.response).toBeDefined();

    // Verify execPython was called with correct arguments
    expect(execPython).toHaveBeenCalledTimes(1);
    const execCall = execPython.mock.calls[0];
    expect(execCall[1]).toEqual(['--ticker', '600519', '--count', '60']);
  });

  it('should handle Chinese direction parsing correctly', async () => {
    // Mock execPython
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    // Mock OpenAI client with Chinese directions
    const mockCreate = vi.mocked(mockClient.chat.completions.create);

    mockCreate
      .mockResolvedValueOnce({
        choices: [{ message: { content: '分析 <!-- VERDICT: {"direction": "看多", "reason": "技术面向好"} -->' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }
      } as any)
      .mockResolvedValueOnce({
        choices: [{ message: { content: '决策 <!-- VERDICT: {"direction": "买入", "reason": "建议买入"} -->' } }],
        usage: { prompt_tokens: 800, completion_tokens: 300, total_tokens: 1100 }
      } as any);

    const result = await runQuickAnalysis('600519', '2026-06-05', config, mockClient);

    // Verify Chinese directions are parsed correctly
    expect(result.final.direction).toBe('Buy'); // '买入' should map to 'Buy'
    expect(result.analyst.verdict.direction).toBe('看多');
  });

  it('should handle various direction formats', async () => {
    vi.mocked(execPython).mockResolvedValue({
      success: true,
      data: { ticker: '600519', data: [] }
    });

    const mockCreate = vi.mocked(mockClient.chat.completions.create);

    // Test 'Hold' direction
    mockCreate
      .mockResolvedValueOnce({
        choices: [{ message: { content: '分析 <!-- VERDICT: {"direction": "中性", "reason": "观望"} -->' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }
      } as any)
      .mockResolvedValueOnce({
        choices: [{ message: { content: '决策 <!-- VERDICT: {"direction": "持有", "reason": "继续持有"} -->' } }],
        usage: { prompt_tokens: 800, completion_tokens: 300, total_tokens: 1100 }
      } as any);

    const result = await runQuickAnalysis('600519', '2026-06-05', config, mockClient);
    expect(result.final.direction).toBe('Hold');
  });
});
