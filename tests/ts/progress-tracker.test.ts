import { describe, it, expect } from 'vitest';
import { pctInRange, formatElapsed, ProgressTracker, QUICK_WEIGHTS, FULL_WEIGHTS } from '../../src/orchestrator';

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

describe('ProgressTracker', () => {
  function makeTracker(weights: Record<string, [number, number]>) {
    const calls: { msg: string; id?: string }[] = [];
    const log = (msg: string, _t?: number, _c?: number, id?: string) => calls.push({ msg, id });
    const tracker = new ProgressTracker(1000, log as any, weights);
    return { tracker, calls };
  }

  it('emits overall-progress with pct and elapsed for a known stage', () => {
    const { tracker, calls } = makeTracker({ data: [0, 5] });
    tracker.emit('data');
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('overall-progress');
    expect(calls[0].msg).toContain('5%');
    expect(calls[0].msg).toContain('已用');
  });

  it('silently skips unknown stage (no log call)', () => {
    const { tracker, calls } = makeTracker({ data: [0, 5] });
    tracker.emit('nonexistent');
    expect(calls).toHaveLength(0);
  });

  it('never decreases pct — backwards/again emit is a no-op (monotonic + dedupe)', () => {
    const { tracker, calls } = makeTracker({ analysts: [5, 80], trader: [80, 88] });
    tracker.emit('trader');         // 88 → emits, lastPct=88
    tracker.emit('analysts', 1);    // 80 ≤ 88 → skipped (would go backwards)
    tracker.emit('trader');         // 88 ≤ 88 → skipped (dedupe)
    expect(calls).toHaveLength(1);
    expect(calls[0].msg).toContain('88%');
  });

  it('advances by fraction within a stage range', () => {
    const { tracker, calls } = makeTracker({ analysts: [5, 80] });
    tracker.emit('analysts', 3 / 7);  // 5 + 75*(3/7) = 37.14 → 37
    expect(calls[0].msg).toContain('37%');
  });

  it('QUICK_WEIGHTS and FULL_WEIGHTS are monotonic 0→100', () => {
    function check(w: Record<string, [number, number]>) {
      const vals = Object.values(w);
      for (const [lo, hi] of vals) {
        expect(lo).toBeLessThanOrEqual(hi);
      }
      expect(vals[0][0]).toBe(0);
      const last = vals[vals.length - 1];
      expect(last[1]).toBe(100);
    }
    check(QUICK_WEIGHTS);
    check(FULL_WEIGHTS);
  });
});
