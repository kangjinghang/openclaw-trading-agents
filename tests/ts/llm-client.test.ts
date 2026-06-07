// tests/ts/llm-client.test.ts

import { describe, it, expect } from 'vitest';
import { parseVerdict } from '../../src/llm-client';

describe('parseVerdict', () => {
  // ── Layer 1: VERDICT tag extraction ─────────────────────────────

  it('should parse single-value Chinese VERDICT', () => {
    const content = '分析报告\n\n<!-- VERDICT: {"direction": "看多", "reason": "估值合理"} -->';
    const result = parseVerdict(content);
    expect(result).toEqual({ direction: '看多', reason: '估值合理' });
  });

  it('should parse single-value English VERDICT', () => {
    const content = 'Report\n\n<!-- VERDICT: {"direction": "Buy", "reason": "bullish"} -->';
    const result = parseVerdict(content);
    expect(result).toEqual({ direction: 'Buy', reason: 'bullish' });
  });

  it('should parse pass/revise/reject VERDICT', () => {
    const content = 'Risk assessment\n\n<!-- VERDICT: {"direction": "pass", "reason": "risk ok"} -->';
    const result = parseVerdict(content);
    expect(result).toEqual({ direction: 'pass', reason: 'risk ok' });
  });

  it('should parse VERDICT even if LLM outputs pipe-separated direction', () => {
    const content = 'Report\n\n<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "ambiguous"} -->';
    const result = parseVerdict(content);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('看多|看空|中性');
  });

  it('should handle VERDICT with extra whitespace', () => {
    const content = 'Report\n\n<!--  VERDICT:  {"direction": "Hold", "reason": "neutral"}  -->';
    const result = parseVerdict(content);
    expect(result).toEqual({ direction: 'Hold', reason: 'neutral' });
  });

  it('should fall through to keyword scan for malformed VERDICT JSON', () => {
    // Malformed JSON inside VERDICT tag → layer 1 fails → layer 3 keyword scan
    const content = '<!-- VERDICT: {invalid json} -->\n\n建议买入';
    const result = parseVerdict(content);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('Buy');
  });

  it('should fall through when direction or reason is missing in VERDICT', () => {
    const content = '<!-- VERDICT: {"direction": "Buy"} -->\n\n综合判断：持有';
    const result = parseVerdict(content);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('Hold');
  });

  // ── Layer 2: Explicit label patterns ────────────────────────────

  it('should extract direction from 最终裁决 label', () => {
    const content = '分析报告\n\n最终裁决：建议买入';
    const result = parseVerdict(content);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('Buy');
  });

  it('should extract direction from 方向 label', () => {
    const content = '分析报告\n\n方向：看空，风险较大';
    const result = parseVerdict(content);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('Sell');
  });

  it('should extract direction from 核心定性 label', () => {
    const content = '核心定性：中性偏谨慎';
    const result = parseVerdict(content);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('Hold');
  });

  it('should extract direction from 结论 label', () => {
    const content = '结论：建议卖出止损';
    const result = parseVerdict(content);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('Sell');
  });

  it('should extract direction from 综合判断 label', () => {
    const content = '综合判断：建议建仓';
    const result = parseVerdict(content);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('Buy');
  });

  // ── Layer 3: Keyword scan ───────────────────────────────────────

  it('should detect Buy from keywords in first 20 lines', () => {
    const content = '市场分析报告\n\n技术面看多，建议做多';
    const result = parseVerdict(content);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('Buy');
  });

  it('should detect Sell from keywords in first 20 lines', () => {
    const content = '市场分析报告\n\n建议卖出，回避风险';
    const result = parseVerdict(content);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('Sell');
  });

  it('should detect Hold from keywords in first 20 lines', () => {
    const content = '市场分析报告\n\n建议观望，中性判断';
    const result = parseVerdict(content);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('Hold');
  });

  // ── No signal at all ────────────────────────────────────────────

  it('should return null when no direction signal found', () => {
    const content = 'Just a regular report without any verdict or direction keywords.';
    expect(parseVerdict(content)).toBeNull();
  });

  it('should return null for empty content', () => {
    expect(parseVerdict('')).toBeNull();
  });

  // ── Priority: Layer 1 > Layer 2 > Layer 3 ──────────────────────

  it('should prefer VERDICT tag over explicit labels', () => {
    const content = '最终裁决：建议卖出\n\n<!-- VERDICT: {"direction": "Buy", "reason": "override"} -->';
    const result = parseVerdict(content);
    expect(result).toEqual({ direction: 'Buy', reason: 'override' });
  });

  it('should prefer explicit labels over keyword scan', () => {
    const content = '看多信号\n\n最终裁决：建议卖出';
    const result = parseVerdict(content);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('Sell');
  });

  // ── Sell wins over Buy on tie (conservative) ───────────────────

  it('should prefer Sell when buy and sell keywords tie', () => {
    const content = '市场分析报告\n\n做多和做空信号并存';
    const result = parseVerdict(content);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('Sell');
  });
});
