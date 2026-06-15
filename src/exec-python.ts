// src/exec-python.ts

import { spawn, execSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ScriptResult } from './types';
import { PYTHON_SCRIPT_TIMEOUT_MS, CACHE_TTL_MS, DEFAULT_CACHE_DIR } from './constants';

// ── Python resolver ─────────────────────────────────────────────────

/** Cached resolved Python command */
let resolvedPython: string | null = null;

/**
 * Auto-detect a Python binary that has the required dependencies.
 * Checks candidates in priority order, caches the first one that works.
 *
 * Priority:
 * 1. TRADING_PYTHON env var (user explicit override)
 * 2. python3 (PATH lookup)
 * 3. /usr/bin/python3 (system)
 * 4. /opt/homebrew/bin/python3 (Homebrew macOS)
 * 5. ~/.pyenv/shims/python3 (pyenv)
 *
 * Falls back to 'python3' if none have `requests` installed.
 */
export function resolvePythonCmd(): string {
  if (resolvedPython) return resolvedPython;

  const candidates = [
    process.env.TRADING_PYTHON,
    'python3',
    '/usr/bin/python3',
    '/opt/homebrew/bin/python3',
    path.join(os.homedir(), '.pyenv/shims/python3'),
  ].filter(Boolean) as string[];

  for (const cmd of candidates) {
    try {
      execSync(`${cmd} -c "import requests"`, {
        timeout: 5000,
        stdio: 'pipe',
        env: { ...process.env, PYTHONUTF8: '1' },
      });
      resolvedPython = cmd;
      console.error(`[exec-python] resolved python: ${cmd}`);
      return cmd;
    } catch {
      // try next candidate
    }
  }

  // No candidate has requests — fallback to bare python3
  resolvedPython = 'python3';
  console.error('[exec-python] no python with requests found, falling back to python3');
  return 'python3';
}

/** Reset the cached Python resolver (for testing) */
export function resetPythonResolver(): void {
  resolvedPython = null;
}

// ── Cache helpers ──────────────────────────────────────────────────

/** Compute a cache key from script path + args */
function cacheKey(scriptPath: string, args: string[]): string {
  const raw = `${scriptPath} ${args.join(' ')}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

interface CacheEntry {
  timestamp: number;
  result: ScriptResult;
}

/** Resolve cache directory, creating it if needed */
function ensureCacheDir(cacheDir?: string): string {
  const dir = (cacheDir || DEFAULT_CACHE_DIR).replace('~', os.homedir());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Try to read a cached result. Returns undefined if not found or expired. */
export function readCache(
  scriptPath: string,
  args: string[],
  ttlMs: number = CACHE_TTL_MS,
  cacheDir?: string
): ScriptResult | undefined {
  try {
    const dir = ensureCacheDir(cacheDir);
    const filePath = path.join(dir, cacheKey(scriptPath, args) + '.json');
    if (!fs.existsSync(filePath)) return undefined;

    const entry: CacheEntry = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (Date.now() - entry.timestamp > ttlMs) return undefined;

    return entry.result;
  } catch {
    return undefined;
  }
}

/** Write a successful result to cache */
export function writeCache(
  scriptPath: string,
  args: string[],
  result: ScriptResult,
  cacheDir?: string
): void {
  if (!result.success) return;
  try {
    const dir = ensureCacheDir(cacheDir);
    const filePath = path.join(dir, cacheKey(scriptPath, args) + '.json');
    const entry: CacheEntry = { timestamp: Date.now(), result };
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(entry), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Cache write failure is non-fatal
  }
}

// ── Python execution ───────────────────────────────────────────────

/**
 * Execute a Python script and capture its JSON output.
 * Results are cached when `useCache` is true (default).
 * @param scriptPath - Absolute path to the Python script
 * @param args - Command line arguments to pass to the script
 * @param stdinData - Optional data to pass via stdin
 * @param pythonCmd - Python command to use (defaults to 'python3')
 * @param timeoutMs - Timeout in milliseconds
 * @param useCache - Whether to use cache (default: true)
 * @param cacheDir - Override cache directory (default: ~/.openclaw/cache)
 */
export async function execPython(
  scriptPath: string,
  args: string[] = [],
  stdinData: any = null,
  pythonCmd: string = 'python3',
  timeoutMs: number = PYTHON_SCRIPT_TIMEOUT_MS,
  useCache: boolean = true,
  cacheDir?: string
): Promise<ScriptResult> {
  // Check cache first
  if (useCache && stdinData === null) {
    const cached = readCache(scriptPath, args, CACHE_TTL_MS, cacheDir);
    if (cached) {
      console.error(`  [cache] hit: ${path.basename(scriptPath)} ${args.join(' ')}`);
      return cached;
    }
  }

  // Call through the indirection handle so tests can swap _execPythonRawHandle.run
  // to simulate transient failures (a direct call to the bare execPythonRaw
  // binding cannot be intercepted by vi.spyOn, which patches the export only).
  let result = await _execPythonRawHandle.run(scriptPath, args, stdinData, pythonCmd, timeoutMs);

  // Retry once on a TIMEOUT only. Timeouts are usually transient (a slow
  // mootdx/akshare upstream, a momentary network blip) and the data scripts
  // carry their own internal source fallback (kline: mootdx→akshare) that a
  // fresh process gets a clean shot at. Other failures (non-zero exit, JSON
  // parse error) are NOT retried: those indicate a real fault (broken script,
  // changed upstream schema) and retrying would just double the diagnostic
  // time. Observed: 600519's kline call timed out once at 30s, succeeded on
  // the next day's run — exactly the transient case this covers.
  if (!result.success && typeof result.error === 'string' && result.error.includes('timed out')) {
    console.error(`  [exec-python] timeout, retrying once: ${path.basename(scriptPath)} ${args.join(' ')}`);
    result = await _execPythonRawHandle.run(scriptPath, args, stdinData, pythonCmd, timeoutMs);
  }

  // Cache successful results
  if (useCache && result.success && stdinData === null) {
    writeCache(scriptPath, args, result, cacheDir);
  }

  return result;
}

/** Raw Python execution without caching (spawns the subprocess, captures
 *  stdout/stderr, parses JSON). Exported so it can be referenced by the
 *  indirection handle below. */
export function execPythonRaw(
  scriptPath: string,
  args: string[],
  stdinData: any,
  pythonCmd: string,
  timeoutMs: number
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    // PYTHONUTF8=1 + -X utf8 force Python 3.7+ to use UTF-8 for stdout/stderr.
    // On Windows, Python defaults to the system locale (GBK for zh-CN),
    // which garbles Chinese characters when Node decodes as UTF-8.
    // On Linux/macOS this is a no-op (already UTF-8).
    // Both the env var AND the CLI flag are needed: the env var covers
    // child processes / library code; the flag covers the main interpreter's
    // stdin/stdout encoding (env var alone can miss the pipe case on Windows).
    const python = spawn(pythonCmd, ['-X', 'utf8', scriptPath, ...args], {
      env: { ...process.env, PYTHONUTF8: '1' },
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    // Kill process after timeout
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        python.kill('SIGKILL');
        resolve({
          success: false,
          error: `Python script timed out after ${timeoutMs}ms: ${scriptPath}`
        });
      }
    }, timeoutMs);

    // Handle stdin input — always close stdin to send EOF so Python's
    // sys.stdin.read() doesn't block indefinitely in non-tty (spawn) mode
    if (stdinData !== null) {
      try {
        python.stdin.write(JSON.stringify(stdinData));
        python.stdin.end();
      } catch (error) {
        resolve({
          success: false,
          error: `Failed to write to stdin: ${error instanceof Error ? error.message : String(error)}`
        });
        python.kill();
        return;
      }
    } else {
      python.stdin.end();
    }

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      if (resolved) return;
      clearTimeout(timer);
      resolved = true;

      if (code !== 0) {
        resolve({
          success: false,
          error: `Python script failed with exit code ${code}. stderr: ${stderr}`
        });
        return;
      }

      if (!stdout.trim()) {
        resolve({
          success: false,
          error: 'Python script produced no output'
        });
        return;
      }

      try {
        const raw = JSON.parse(stdout.trim());
        // Extract pre-computed fields to top level for data scripts
        // that output {success, data, vpa, technical_indicators} format.
        // For generic JSON output, keep the whole object as data.
        const isDataScriptFormat = typeof raw.success === 'boolean' && raw.data !== undefined;
        const result: ScriptResult = {
          success: true,
          data: isDataScriptFormat ? raw.data : raw,
        };
        if (isDataScriptFormat) {
          if (typeof raw.vpa === 'string') {
            result.vpa = raw.vpa;
          }
          if (typeof raw.technical_indicators === 'string') {
            result.technical_indicators = raw.technical_indicators;
          }
        }
        // Surface non-fatal source/sub-source failures recorded by the script
        // (http_helpers.record_error → output_json _errors array) so a silent
        // partial outage is observable. Works for both data-script format and
        // generic JSON output, since output_json always writes _errors at the
        // top level when non-empty.
        if (Array.isArray(raw._errors)) {
          result.errors = raw._errors;
        }
        resolve(result);
      } catch (error) {
        resolve({
          success: false,
          error: `Failed to parse JSON output: ${error instanceof Error ? error.message : String(error)}. Raw output: ${stdout}`
        });
      }
    });

    python.on('error', (error) => {
      if (resolved) return;
      clearTimeout(timer);
      resolved = true;
      resolve({
        success: false,
        error: `Failed to start Python process: ${error.message}`
      });
    });
  });
}

/** Indirection over execPythonRaw so tests can swap `.run` to simulate
 *  transient failures (e.g. a timeout-then-success sequence) without spawning
 *  real subprocesses. execPython calls _execPythonRawHandle.run instead of the
 *  bare execPythonRaw binding because vi.spyOn would only patch the export,
 *  not the local call site — leaving the retry path untestable. Declared as a
 *  mutable object (not reassigned) so test patches persist across the SUT's
 *  reads of .run. */
export const _execPythonRawHandle = { run: execPythonRaw };

/**
 * Execute a skill script from the skills directory
 * @param skillName - Name of the skill (e.g., 'trading-kline')
 * @param scriptName - Name of the script file without .py extension (e.g., 'get-data')
 * @param projectRoot - Root directory of the project
 * @param args - Command line arguments to pass to the script
 * @param stdinData - Optional data to pass via stdin
 * @returns Promise<ScriptResult> - The parsed JSON output with _source field
 */
export async function execSkillScript(
  skillName: string,
  scriptName: string,
  projectRoot: string,
  args: string[] = [],
  stdinData: any = null,
  timeoutMs: number = PYTHON_SCRIPT_TIMEOUT_MS
): Promise<ScriptResult> {
  const scriptPath = `${projectRoot}/skills/${skillName}/scripts/${scriptName}.py`;

  const result = await execPython(scriptPath, args, stdinData, resolvePythonCmd(), timeoutMs);

  // Add source information to result
  if (result.success) {
    result._source = `${skillName}:${scriptName}`;
  } else {
    // Improve error message for script not found
    if (result.error?.includes('No such file or directory')) {
      result.error = `Script not found: ${scriptPath}`;
    }
  }

  return result;
}
