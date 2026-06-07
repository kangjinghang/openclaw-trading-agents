// tests/ts/research_manager.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runResearchManager } from '../../src/research-manager';
import { TradingAgentsConfig, AnalystReport, DebateResult } from '../../src/types';
import OpenAI from 'openai';

const mockConfig: TradingAgentsConfig = {
  models: { analyst: 'gpt-4o', debater: 'gpt-4o', decision: 'gpt-4o', risk: 'gpt-4o' },
  debate_rounds: 2,
  risk_debate_rounds: 1,
  max_risk_retries: 1,
  llm_concurrency: 3,
  report_dir: '/tmp/test-reports',
};

function mockDebateResult(): DebateResult {
  return {
    rounds: [
      { round: 1, bull_claims: [{ id: 'BULL-1', side: 'bull', topic: '政策利好', evidence: '政策支持', confidence: 0.8 }], bear_claims: [{ id: 'BEAR-1', side: 'bear', topic: '估值偏高', evidence: 'PE高', confidence: 0.7 }] },
      { round: 2, bull_claims: [{ id: 'BULL-2', side: 'bull', topic: '北向流入', evidence: '净流入', confidence: 0.6 }], bear_claims: [{ id: 'BEAR-2', side: 'bear', topic: '解禁压力', evidence: '大额解禁', confidence: 0.5 }] },
    ],
    bull_summary: '多头逻辑：政策利好+北向流入',
    bear_summary: '空头风险：估值偏高+解禁压力',
    total_tokens: 3600,
    total_cost_usd: 0.01,
  };
}

describe('runResearchManager', () => {
  let mockClient: OpenAI;
  let mockTraceLogger: any;

  beforeEach(() => {
    mockClient = {
      chat: { completions: { create: vi.fn() } }
    } as any;
    mockTraceLogger = { record: vi.fn(), count: 0 };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should score debate and return ResearchDecision', async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: `### 评分
- **多头得分**：75
- **空头得分**：45

### 关键辩论焦点
1. 政策利好是否持续
2. 估值是否合理

### 最终决策
- **方向**：Overweight
- **信心水平**：0.72

<!-- VERDICT: {"direction": "Overweight", "reason": "多头论据更充分"} -->`
        }
      }],
      usage: { prompt_tokens: 1000, completion_tokens: 400, total_tokens: 1400 }
    } as any);

    const reports: AnalystReport[] = [
      { role: 'market', content: 'Market report', verdict: { direction: '看多', reason: '趋势向上' }, data_sources_used: ['kline'] },
    ];
    const debate = mockDebateResult();

    const result = await runResearchManager(reports, debate, "", mockConfig, mockClient, mockTraceLogger);

    expect(result.direction).toBe('Overweight');
    expect(result.confidence).toBe(0.72);
    expect(result.bull_score).toBe(75);
    expect(result.bear_score).toBe(45);
    expect(result.key_debate_points).toContain('政策利好是否持续');
    expect(result.verdict.direction).toBe('Overweight');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('should parse Chinese direction correctly', async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: `### 评分
- **多头得分**：80
- **空头得分**：30

### 关键辩论焦点
1. 政策力度

### 最终决策
- **方向**：买入
- **信心水平**：0.85

<!-- VERDICT: {"direction": "买入", "reason": "强烈看多"} -->`
        }
      }],
      usage: { prompt_tokens: 1000, completion_tokens: 400, total_tokens: 1400 }
    } as any);

    const reports: AnalystReport[] = [
      { role: 'market', content: 'Report', verdict: { direction: '看多', reason: 'up' }, data_sources_used: ['kline'] },
    ];
    const debate = mockDebateResult();

    const result = await runResearchManager(reports, debate, "", mockConfig, mockClient, mockTraceLogger);

    expect(result.direction).toBe('Buy');
    expect(result.verdict.direction).toBe('买入');
  });

  it('should default to Hold when verdict is missing', async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: `### 评分
- **多头得分**：50
- **空头得分**：50

### 最终决策
- **信心水平**：0.5`
        }
      }],
      usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 }
    } as any);

    const reports: AnalystReport[] = [
      { role: 'market', content: 'Report', verdict: { direction: '中性', reason: 'neutral' }, data_sources_used: ['kline'] },
    ];
    const debate = mockDebateResult();

    const result = await runResearchManager(reports, debate, "", mockConfig, mockClient, mockTraceLogger);

    expect(result.direction).toBe('Hold');
    expect(result.confidence).toBe(0.5);
    expect(result.bull_score).toBe(50);
    expect(result.bear_score).toBe(50);
    expect(result.verdict.direction).toBe('Hold');
    expect(result.verdict.reason).toBe('无法解析结论');
  });

  it('should default scores when parsing fails', async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: `No scores here.

<!-- VERDICT: {"direction": "Sell", "reason": "风险太大"} -->`
        }
      }],
      usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 }
    } as any);

    const reports: AnalystReport[] = [
      { role: 'market', content: 'Report', verdict: { direction: '看空', reason: 'down' }, data_sources_used: ['kline'] },
    ];
    const debate = mockDebateResult();

    const result = await runResearchManager(reports, debate, "", mockConfig, mockClient, mockTraceLogger);

    expect(result.direction).toBe('Sell');
    expect(result.bull_score).toBe(50);
    expect(result.bear_score).toBe(50);
    expect(result.confidence).toBe(0.5);
    expect(result.key_debate_points).toEqual([]);
  });
});
