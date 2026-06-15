// tests/ts/exec-python-retry.test.ts
//
// Tests for the timeout-retry path in execPython. These swap
// _execPythonRawHandle.run to return queued fixtures instead of spawning real
// subprocesses — the retry logic is the SUT, not the subprocess execution
// (exec-python.test.ts covers real scripts end-to-end).
//
// We patch the indirection handle (not vi.spyOn on the export) because
// execPython calls the raw function through that handle: a direct local call
// cannot be intercepted by an export-level spy.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _execPythonRawHandle } from '../../src/exec-python';
import { ScriptResult } from '../../src/types';

const rawReturns: ScriptResult[] = [];
let rawCallCount = 0;

describe('execPython timeout retry', () => {
  let originalRun: typeof _execPythonRawHandle.run;

  beforeEach(() => {
    originalRun = _execPythonRawHandle.run;
    rawReturns.length = 0;
    rawCallCount = 0;
    _execPythonRawHandle.run = async () => {
      const r = rawReturns[rawCallCount];
      rawCallCount++;
      return r;
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _execPythonRawHandle.run = originalRun;
    vi.restoreAllMocks();
  });

  // Dynamically import so the SUT reads the patched handle at call time.
  async function loadExecPython() {
    return (await import('../../src/exec-python')).execPython;
  }

  it('retries once on timeout then succeeds', async () => {
    // The transient case observed on 600519's kline call: first attempt times
    // out, the retry succeeds. execPython should retry exactly once and return
    // the successful result (not the timeout error).
    rawReturns.push(
      { success: false, error: 'Python script timed out after 30000ms: kline.py' },
      { success: true, data: { recovered: true } }
    );

    const execPython = await loadExecPython();
    const result = await execPython('/fake/kline.py', [], null, 'python3', 30_000, false);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ recovered: true });
    expect(rawCallCount).toBe(2); // original + exactly 1 retry
  });

  it('does NOT retry on non-timeout failures (e.g. JSON parse error)', async () => {
    // A broken-script / parse failure should not be retried: retrying a real
    // fault just doubles the diagnostic time for no benefit.
    rawReturns.push(
      { success: false, error: 'Failed to parse JSON output: ...' }
    );

    const execPython = await loadExecPython();
    const result = await execPython('/fake/script.py', [], null, 'python3', 30_000, false);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to parse JSON');
    expect(rawCallCount).toBe(1); // no retry attempted
  });

  it('retries once on timeout and surfaces the timeout when retry also times out', async () => {
    // If the retry also times out, execPython must give up after exactly one
    // retry (not loop indefinitely) and surface the timeout error.
    rawReturns.push(
      { success: false, error: 'Python script timed out after 30000ms: kline.py' },
      { success: false, error: 'Python script timed out after 30000ms: kline.py' }
    );

    const execPython = await loadExecPython();
    const result = await execPython('/fake/kline.py', [], null, 'python3', 30_000, false);

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    expect(rawCallCount).toBe(2); // original + exactly 1 retry, no further
  });

  it('does not retry a successful call', async () => {
    rawReturns.push({ success: true, data: { ok: true } });

    const execPython = await loadExecPython();
    const result = await execPython('/fake/script.py', [], null, 'python3', 30_000, false);

    expect(result.success).toBe(true);
    expect(rawCallCount).toBe(1);
  });
});
