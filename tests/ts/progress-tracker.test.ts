import { describe, it, expect } from 'vitest';
import { pctInRange, formatElapsed } from '../../src/orchestrator';

describe('pctInRange', () => {
  it('computes percentage within range by fraction', () => {
    expect(pctInRange([5, 80], 0)).toBe(5);
    expect(pctInRange([5, 80], 0.5)).toBe(43);   // 5 + 75*0.5 = 42.5 → Math.round → 43
    expect(pctInRange([5, 80], 1)).toBe(80);
  });

  it('clamps frac outside [0,1] to endpoints', () => {
    expect(pctInRange([5, 80], -0.5)).toBe(5);
    expect(pctInRange([5, 80], 1.5)).toBe(80);
  });

  it('handles zero-width range', () => {
    expect(pctInRange([50, 50], 0.3)).toBe(50);
  });
});

describe('formatElapsed', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(45000)).toBe('45s');
    expect(formatElapsed(59000)).toBe('59s');
  });

  it('formats >=60s as m:ss', () => {
    expect(formatElapsed(60000)).toBe('1m0s');
    expect(formatElapsed(90000)).toBe('1m30s');
    expect(formatElapsed(240000)).toBe('4m0s');
  });
});