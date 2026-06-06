// tests/ts/llm-client.test.ts

import { describe, it, expect } from 'vitest';
import { parseVerdict } from '../../src/llm-client';

describe('parseVerdict', () => {
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
    // This is the bug the prompt fix prevents, but parseVerdict should still extract it
    const content = 'Report\n\n<!-- VERDICT: {"direction": "看多|看空|中性", "reason": "ambiguous"} -->';
    const result = parseVerdict(content);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('看多|看空|中性');
    // parseDirection() handles the pipe-split downstream
  });

  it('should return null when no VERDICT comment found', () => {
    const content = 'Just a regular report without any verdict.';
    expect(parseVerdict(content)).toBeNull();
  });

  it('should return null for malformed JSON in VERDICT', () => {
    const content = '<!-- VERDICT: {invalid json} -->';
    expect(parseVerdict(content)).toBeNull();
  });

  it('should return null when direction or reason is missing', () => {
    const content = '<!-- VERDICT: {"direction": "Buy"} -->';
    expect(parseVerdict(content)).toBeNull();
  });

  it('should handle VERDICT with extra whitespace', () => {
    const content = 'Report\n\n<!--  VERDICT:  {"direction": "Hold", "reason": "neutral"}  -->';
    const result = parseVerdict(content);
    expect(result).toEqual({ direction: 'Hold', reason: 'neutral' });
  });
});
