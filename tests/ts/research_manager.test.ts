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
    convergence_score: 0.5,
    resolved_points: [],
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
    mockTraceLogger = { record: vi.fn(), recordWarning: vi.fn(), count: 0 };
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

  it('should use decision_deep model when set (deep-thinking tier for the gatekeeper)', async () => {
    const deepConfig: TradingAgentsConfig = {
      ...mockConfig,
      models: { ...mockConfig.models, decision_deep: 'glm-4.6' },
    };
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '<!-- VERDICT: {"direction": "Hold", "reason": "x"} -->' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    } as any);

    await runResearchManager([], mockDebateResult(), '', deepConfig, mockClient, mockTraceLogger);

    const callArgs = mockCreate.mock.calls[0][0] as any;
    expect(callArgs.model).toBe('glm-4.6');
  });

  it('should fall back to decision model when decision_deep is unset', async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '<!-- VERDICT: {"direction": "Hold", "reason": "x"} -->' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    } as any);

    await runResearchManager([], mockDebateResult(), '', mockConfig, mockClient, mockTraceLogger);

    const callArgs = mockCreate.mock.calls[0][0] as any;
    expect(callArgs.model).toBe('gpt-4o'); // mockConfig.models.decision
  });

  it('prefers structured bull_score/bear_score/confidence from VERDICT block', async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          // 正则路径会抽到 75/45/0.72，但 VERDICT 块的结构化值 80/30/0.9 应当胜出
          content: `### 评分
- **多头得分**：75
- **空头得分**：45

### 最终决策
- **信心水平**：0.72

<!-- VERDICT: {"direction": "Buy", "reason": "x", "bull_score": 80, "bear_score": 30, "confidence": 0.9} -->`
        }
      }],
      usage: { prompt_tokens: 1000, completion_tokens: 400, total_tokens: 1400 }
    } as any);

    const result = await runResearchManager([], mockDebateResult(), '', mockConfig, mockClient, mockTraceLogger);

    expect(result.bull_score).toBe(80);   // 结构化值，非正则的 75
    expect(result.bear_score).toBe(30);   // 结构化值，非正则的 45
    expect(result.confidence).toBe(0.9);  // 结构化值，非正则的 0.72
    // 全部走结构化路径，不应有 fallback warning
    const warnings = mockTraceLogger.recordWarning.mock.calls;
    expect(warnings.length).toBe(0);
  });

  it('records a warning when structured score fields are missing (fallback no longer silent)', async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          content: `### 评分
- **多头得分**：60
- **空头得分**：55

<!-- VERDICT: {"direction": "Buy", "reason": "x"} -->`
        }
      }],
      usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 }
    } as any);

    await runResearchManager([], mockDebateResult(), '', mockConfig, mockClient, mockTraceLogger);

    const warnings = mockTraceLogger.recordWarning.mock.calls.map((c: any[]) => c[0].fn);
    // VERDICT 块缺 bull_score/bear_score → 走正则 fallback 但记录 warning
    expect(warnings).toContain('parseScores');
    // confidence 缺失 → 同样记录 warning
    expect(warnings).toContain('parseConfidence');
  });

  it('clamps fallback confidence into [0,1]', async () => {
    const mockCreate = vi.mocked(mockClient.chat.completions.create);
    mockCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          // 信心水平写成 1.4（0-100 误用），正则会抽到 1.4，必须 clamp 到 1
          content: `### 评分
- **多头得分**：60
- **空头得分**：55

### 最终决策
- **信心水平**：1.4

<!-- VERDICT: {"direction": "Buy", "reason": "x"} -->`
        }
      }],
      usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 }
    } as any);

    const result = await runResearchManager([], mockDebateResult(), '', mockConfig, mockClient, mockTraceLogger);

    expect(result.confidence).toBe(1);
  });
});
