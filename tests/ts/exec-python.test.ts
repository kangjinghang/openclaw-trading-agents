// tests/ts/exec-python.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execPython, execSkillScript, resolvePythonCmd, resetPythonResolver } from '../../src/exec-python';
import { writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { mkdir, readdir } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/** Clear all cache files to prevent cross-run interference */
async function clearCache() {
  const cacheDir = join(os.homedir(), '.openclaw', 'cache');
  try {
    const files = await readdir(cacheDir);
    for (const f of files) {
      if (f.endsWith('.json')) {
        await rm(join(cacheDir, f), { force: true });
      }
    }
  } catch {
    // dir may not exist
  }
}

// Tests use useCache:false to avoid cache interference

// Resolve a working python once for the execPython tests below. They previously
// hardcoded 'python3', which only exists on POSIX — on Windows the interpreter
// is 'python' (or the project .venv), so the tests failed with exit code 9009
// ("command not found") there. Using resolvePythonCmd() makes the suite portable
// without changing what is being asserted (the tests just need *a* python).
const PYTHON = resolvePythonCmd();

describe('execPython', () => {
  const tmpDir = join(process.cwd(), 'test-tmp');
  let testScriptPath: string;

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
    testScriptPath = join(tmpDir, 'test-script.py');
    await clearCache();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await clearCache();
  });

  it('should execute Python script and return JSON output', async () => {
    const script = `
import sys
import json

result = {
    "status": "success",
    "data": {"value": 42, "message": "hello"}
}

print(json.dumps(result))
`;

    await writeFile(testScriptPath, script, 'utf-8');
    const result = await execPython(testScriptPath, [], null, PYTHON, 30_000, false);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      status: "success",
      data: { value: 42, message: "hello" }
    });
  });

  it('should handle Python script execution with arguments', async () => {
    const script = `
import sys
import json

args = sys.argv[1:]
result = {
    "args": args,
    "count": len(args)
}

print(json.dumps(result))
`;

    await writeFile(testScriptPath, script, 'utf-8');
    const result = await execPython(testScriptPath, ['arg1', 'arg2', 'arg3'], null, PYTHON, 30_000, false);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      args: ['arg1', 'arg2', 'arg3'],
      count: 3
    });
  });

  it('should handle stdin input for Python scripts', async () => {
    const script = `
import sys
import json

input_data = json.loads(sys.stdin.read())
result = {
    "received": input_data,
    "processed": True
}

print(json.dumps(result))
`;

    await writeFile(testScriptPath, script, 'utf-8');
    const inputData = { ticker: 'AAPL', timeframe: '1d' };
    const result = await execPython(testScriptPath, [], inputData, PYTHON, 30_000, false);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      received: inputData,
      processed: true
    });
  });

  it('should handle Python script errors gracefully', async () => {
    const script = `
import sys

raise ValueError("This is a test error")
`;

    await writeFile(testScriptPath, script, 'utf-8');
    const result = await execPython(testScriptPath, [], null, PYTHON, 30_000, false);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('ValueError');
    expect(result.error).toContain('This is a test error');
  });

  it('should handle JSON parsing errors', async () => {
    const script = `
print("This is not valid JSON")
print("More invalid output")
`;

    await writeFile(testScriptPath, script, 'utf-8');
    const result = await execPython(testScriptPath, [], null, PYTHON, 30_000, false);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Failed to parse JSON');
  });

  it('should handle missing Python interpreter', async () => {
    // Use a non-existent Python command
    const result = await execPython(testScriptPath, [], null, 'nonexistent-python', 30_000, false);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should handle script that returns empty output', async () => {
    const script = `
# Empty script
`;

    await writeFile(testScriptPath, script, 'utf-8');
    const result = await execPython(testScriptPath, [], null, PYTHON, 30_000, false);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('execSkillScript', () => {
  const tmpDir = join(process.cwd(), 'test-tmp');

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(tmpDir, 'skills'), { recursive: true });
    await mkdir(join(tmpDir, 'skills', 'test-skill'), { recursive: true });
    await mkdir(join(tmpDir, 'skills', 'test-skill', 'scripts'), { recursive: true });
    await clearCache();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await clearCache();
  });

  it('should execute a skill script by name', async () => {
    const scriptPath = join(tmpDir, 'skills', 'test-skill', 'scripts', 'get-data.py');
    const script = `
import sys
import json

result = {
    "skill": "test-skill",
    "script": "get-data",
    "data": {"prices": [100, 101, 102]}
}

print(json.dumps(result))
`;

    await writeFile(scriptPath, script, 'utf-8');
    const result = await execSkillScript('test-skill', 'get-data', tmpDir);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      skill: 'test-skill',
      script: 'get-data',
      data: { prices: [100, 101, 102] }
    });
  });

  it('should pass arguments to skill script', async () => {
    const scriptPath = join(tmpDir, 'skills', 'test-skill', 'scripts', 'analyze.py');
    const script = `
import sys
import json

ticker = sys.argv[1]
timeframe = sys.argv[2]

result = {
    "ticker": ticker,
    "timeframe": timeframe,
    "analysis": "bullish"
}

print(json.dumps(result))
`;

    await writeFile(scriptPath, script, 'utf-8');
    const result = await execSkillScript('test-skill', 'analyze', tmpDir, ['AAPL', '1d']);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      ticker: 'AAPL',
      timeframe: '1d',
      analysis: 'bullish'
    });
  });

  it('should pass stdin data to skill script', async () => {
    const scriptPath = join(tmpDir, 'skills', 'test-skill', 'scripts', 'process.py');
    const script = `
import sys
import json

input_data = json.loads(sys.stdin.read())

result = {
    "input": input_data,
    "output": "processed"
}

print(json.dumps(result))
`;

    await writeFile(scriptPath, script, 'utf-8');
    const inputData = { symbol: 'MSFT', period: '1mo' };
    const result = await execSkillScript('test-skill', 'process', tmpDir, [], inputData);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      input: inputData,
      output: 'processed'
    });
  });

  it('should handle non-existent skill directory', async () => {
    const result = await execSkillScript('nonexistent-skill', 'get-data', tmpDir);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Script not found');
  });

  it('should handle non-existent script file', async () => {
    const result = await execSkillScript('test-skill', 'nonexistent-script', tmpDir);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Script not found');
  });

  it('should include _source in result for skill scripts', async () => {
    const scriptPath = join(tmpDir, 'skills', 'test-skill', 'scripts', 'source-test.py');
    const script = `
import sys
import json

print(json.dumps({"result": "data"}))
`;

    await writeFile(scriptPath, script, 'utf-8');
    const result = await execSkillScript('test-skill', 'source-test', tmpDir);

    expect(result.success).toBe(true);
    expect(result._source).toBe('test-skill:source-test');
  });
});

describe('resolvePythonCmd', () => {
  beforeEach(() => {
    resetPythonResolver();
  });

  it('returns a non-empty string', () => {
    const cmd = resolvePythonCmd();
    expect(cmd).toBeTruthy();
    expect(typeof cmd).toBe('string');
  });

  it('caches the result on second call', () => {
    const first = resolvePythonCmd();
    const second = resolvePythonCmd();
    expect(first).toBe(second);
  });

  it('prioritizes TRADING_PYTHON env var when set and valid', () => {
    // Save and set env. Use a python that has all required deps (requests+akshare+pandas);
    // resolvePythonCmd Phase-1 prefers a python with full deps over a bare python3.
    // Resolve the project venv python (created by setup-python.sh with full deps) so the
    // test does not depend on whether the host's bare `python`/`python3` happens to have
    // akshare/pandas installed — that varies across machines and breaks CI portability.
    const venvPython = path.join(process.cwd(), '.venv', 'bin', 'python');
    const venvPythonWin = path.join(process.cwd(), '.venv', 'Scripts', 'python.exe');
    const fullDepsPython = fs.existsSync(venvPythonWin) ? venvPythonWin
      : fs.existsSync(venvPython) ? venvPython
      : 'python'; // fallback: assume host python has full deps (original behavior)

    const orig = process.env.TRADING_PYTHON;
    process.env.TRADING_PYTHON = fullDepsPython;
    resetPythonResolver();

    const cmd = resolvePythonCmd();
    expect(cmd).toBe(fullDepsPython);

    // Restore
    if (orig) {
      process.env.TRADING_PYTHON = orig;
    } else {
      delete process.env.TRADING_PYTHON;
    }
    resetPythonResolver();
  });

  it('falls back when TRADING_PYTHON points to invalid path', () => {
    const orig = process.env.TRADING_PYTHON;
    process.env.TRADING_PYTHON = '/nonexistent/python XYZ';
    resetPythonResolver();

    const cmd = resolvePythonCmd();
    // Should still return something (fallback to python3)
    expect(cmd).toBeTruthy();

    // Restore
    if (orig) {
      process.env.TRADING_PYTHON = orig;
    } else {
      delete process.env.TRADING_PYTHON;
    }
    resetPythonResolver();
  });
});