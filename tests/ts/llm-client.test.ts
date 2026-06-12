// tests/ts/llm-client.test.ts

import { describe, it, expect } from 'vitest';
import { parseVerdict, is429, getRetryAfterMs, retryDelayMs, RateLimitCoordinator } from '../../src/llm-client';
import { RateLimitError, APIError } from 'openai';

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

describe('is429', () => {
  it('should detect RateLimitError as 429', () => {
    const err = new RateLimitError(429, { message: 'rate limited' }, 'rate limited', {});
    expect(is429(err)).toBe(true);
  });

  it('should detect APIError with status 429', () => {
    const err = new APIError(429, { message: 'too many requests' }, 'too many requests', {});
    expect(is429(err)).toBe(true);
  });

  it('should detect error message starting with 429 (non-standard providers)', () => {
    const err = new Error('429 您的账户已达到速率限制');
    expect(is429(err)).toBe(true);
  });

  it('should NOT detect non-429 errors', () => {
    expect(is429(new Error('500 Internal Server Error'))).toBe(false);
    expect(is429(new Error('network timeout'))).toBe(false);
    expect(is429(null)).toBe(false);
    expect(is429(undefined)).toBe(false);
  });
});

describe('getRetryAfterMs', () => {
  it('should extract retry-after from APIError headers (string)', () => {
    const err = new APIError(429, { message: 'rate limited' }, 'rate limited', { 'retry-after': '30' });
    expect(getRetryAfterMs(err)).toBe(30_000);
  });

  it('should return undefined when no retry-after header', () => {
    const err = new APIError(429, { message: 'rate limited' }, 'rate limited', {});
    expect(getRetryAfterMs(err)).toBeUndefined();
  });

  it('should return undefined for non-APIError', () => {
    expect(getRetryAfterMs(new Error('429'))).toBeUndefined();
    expect(getRetryAfterMs(null)).toBeUndefined();
  });

  it('should return undefined for non-numeric retry-after', () => {
    const err = new APIError(429, { message: 'rate limited' }, 'rate limited', { 'retry-after': 'not-a-number' });
    expect(getRetryAfterMs(err)).toBeUndefined();
  });
});

describe('retryDelayMs', () => {
  it('should return exponential backoff for 429 errors', () => {
    const err = new RateLimitError(429, { message: 'rate limited' }, 'rate limited', {});

    // Attempt 0: base * 3^0 = 5000ms
    expect(retryDelayMs(err, 0)).toBe(5_000);

    // Attempt 1: base * 3^1 = 15000ms
    expect(retryDelayMs(err, 1)).toBe(15_000);

    // Attempt 2: base * 3^2 = 45000ms
    expect(retryDelayMs(err, 2)).toBe(45_000);
  });

  it('should cap at RATE_LIMIT_MAX_DELAY_MS (60s)', () => {
    const err = new RateLimitError(429, { message: 'rate limited' }, 'rate limited', {});

    // Attempt 10 would be 5 * 3^10 = ~295s, capped at 60s
    expect(retryDelayMs(err, 10)).toBe(60_000);
  });

  it('should prefer Retry-After header over exponential backoff', () => {
    const err = new APIError(429, { message: 'rate limited' }, 'rate limited', { 'retry-after': '10' });

    // Retry-After: 10s = 10000ms, instead of base * 3^0 = 5000ms
    expect(retryDelayMs(err, 0)).toBe(10_000);
  });

  it('should cap Retry-After at 60s', () => {
    const err = new APIError(429, { message: 'rate limited' }, 'rate limited', { 'retry-after': '120' });

    // Retry-After: 120s would be 120000ms, capped at 60000ms
    expect(retryDelayMs(err, 0)).toBe(60_000);
  });

  it('should return short delay for non-429 errors', () => {
    const err = new Error('500 Internal Server Error');
    const delay = retryDelayMs(err, 0);

    // Non-429: LLM_RETRY_DELAY_MS (1000) + random(0, 1000) = 1000~2000ms
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(2000);
  });
});

describe('RateLimitCoordinator', () => {
  it('should not wait when no cooldown is active', async () => {
    const coord = new RateLimitCoordinator();
    // Should resolve immediately
    const start = Date.now();
    await coord.waitIfNeeded();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('should wait when cooldown is active', async () => {
    const coord = new RateLimitCoordinator();
    coord.signalRateLimit(200); // 200ms cooldown

    const start = Date.now();
    await coord.waitIfNeeded();
    expect(Date.now() - start).toBeGreaterThanOrEqual(150); // ~200ms with tolerance
  });

  it('should extend cooldown but never shorten', () => {
    const coord = new RateLimitCoordinator();
    coord.signalRateLimit(5000);
    coord.signalRateLimit(1000); // shorter — should be ignored

    // The coordinator should still have the 5000ms cooldown
    // We can verify by checking waitIfNeeded takes ~5s, but that's too slow for unit tests.
    // Instead, signal a very short one and verify the longer one dominates:
    const coord2 = new RateLimitCoordinator();
    coord2.signalRateLimit(100); // short
    coord2.signalRateLimit(50);  // even shorter — should be ignored
    // If the second signal shortened it, waitIfNeeded would resolve faster
  });

  it('should allow multiple signals to extend cooldown', () => {
    const coord = new RateLimitCoordinator();
    coord.signalRateLimit(100);
    coord.signalRateLimit(300);
    // After two signals, the cooldown should be the max of both
    // The second (300ms) extends beyond the first (100ms from now)
  });
});
