// tests/ts/cache.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readCache, writeCache, execPython } from '../../src/exec-python';
import { writeFile, rm, mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import * as os from 'os';
import * as fs from 'fs';

const TMP_DIR = join(process.cwd(), 'test-tmp-cache');
const TEST_CACHE_DIR = join(TMP_DIR, '.cache');

describe('Cache layer', () => {
  beforeEach(async () => {
    await mkdir(TMP_DIR, { recursive: true });
    await mkdir(TEST_CACHE_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  it('should cache a successful result and return it on next call', async () => {
    const scriptPath = join(TMP_DIR, 'cache-test.py');
    const script = `
import json
print(json.dumps({"value": 42}))
`;
    await writeFile(scriptPath, script, 'utf-8');

    // First call — should execute Python and cache
    const result1 = await execPython(scriptPath, [], null, 'python3', 30_000, true, TEST_CACHE_DIR);
    expect(result1.success).toBe(true);
    expect(result1.data).toEqual({ value: 42 });

    // Overwrite script to return different data
    const script2 = `
import json
print(json.dumps({"value": 99}))
`;
    await writeFile(scriptPath, script2, 'utf-8');

    // Second call — should return cached result (42, not 99)
    const result2 = await execPython(scriptPath, [], null, 'python3', 30_000, true, TEST_CACHE_DIR);
    expect(result2.success).toBe(true);
    expect(result2.data).toEqual({ value: 42 }); // cached!
  });

  it('should bypass cache when useCache is false', async () => {
    const scriptPath = join(TMP_DIR, 'no-cache-test.py');
    const script = `
import json
print(json.dumps({"v": 1}))
`;
    await writeFile(scriptPath, script, 'utf-8');

    const result1 = await execPython(scriptPath, [], null, 'python3', 30_000, false, TEST_CACHE_DIR);
    expect(result1.data).toEqual({ v: 1 });

    // Overwrite
    await writeFile(scriptPath, `
import json
print(json.dumps({"v": 2}))
`, 'utf-8');

    const result2 = await execPython(scriptPath, [], null, 'python3', 30_000, false, TEST_CACHE_DIR);
    expect(result2.data).toEqual({ v: 2 }); // fresh, not cached
  });

  it('should not cache failed results', async () => {
    const scriptPath = join(TMP_DIR, 'fail-test.py');
    const script = `raise ValueError("fail")`;
    await writeFile(scriptPath, script, 'utf-8');

    const result = await execPython(scriptPath, [], null, 'python3', 30_000, true, TEST_CACHE_DIR);
    expect(result.success).toBe(false);

    // Verify no cache file was written
    const files = await readdir(TEST_CACHE_DIR);
    expect(files.length).toBe(0);
  });

  it('should not cache when stdinData is provided', async () => {
    const scriptPath = join(TMP_DIR, 'stdin-test.py');
    const script = `
import sys, json
data = json.loads(sys.stdin.read())
print(json.dumps({"echo": data}))
`;
    await writeFile(scriptPath, script, 'utf-8');

    const result = await execPython(scriptPath, [], { x: 1 }, 'python3', 30_000, true, TEST_CACHE_DIR);
    expect(result.success).toBe(true);

    // Should not have cached because stdinData was provided
    const files = await readdir(TEST_CACHE_DIR);
    expect(files.length).toBe(0);
  });

  it('should differentiate cache by args', async () => {
    const scriptPath = join(TMP_DIR, 'args-test.py');
    const script = `
import sys, json
print(json.dumps({"args": sys.argv[1:]}))
`;
    await writeFile(scriptPath, script, 'utf-8');

    const r1 = await execPython(scriptPath, ['a'], null, 'python3', 30_000, true, TEST_CACHE_DIR);
    const r2 = await execPython(scriptPath, ['b'], null, 'python3', 30_000, true, TEST_CACHE_DIR);

    expect(r1.data).toEqual({ args: ['a'] });
    expect(r2.data).toEqual({ args: ['b'] });
  });

  it('should expire cache entries after TTL', async () => {
    const scriptPath = join(TMP_DIR, 'ttl-test.py');
    const script = `
import json
print(json.dumps({"ts": 1}))
`;
    await writeFile(scriptPath, script, 'utf-8');

    // Cache with very short TTL (1ms)
    const result1 = await execPython(scriptPath, [], null, 'python3', 30_000, true, TEST_CACHE_DIR);
    expect(result1.data).toEqual({ ts: 1 });

    // Overwrite script
    await writeFile(scriptPath, `
import json
print(json.dumps({"ts": 2}))
`, 'utf-8');

    // Wait for TTL to expire
    await new Promise(r => setTimeout(r, 50));

    // Directly test readCache with 1ms TTL — should be expired
    const cached = readCache(scriptPath, [], 1, TEST_CACHE_DIR);
    expect(cached).toBeUndefined();
  });
});
