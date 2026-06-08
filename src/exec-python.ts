// src/exec-python.ts

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ScriptResult } from './types';
import { PYTHON_SCRIPT_TIMEOUT_MS, CACHE_TTL_MS, DEFAULT_CACHE_DIR } from './constants';

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

  const result = await execPythonRaw(scriptPath, args, stdinData, pythonCmd, timeoutMs);

  // Cache successful results
  if (useCache && result.success && stdinData === null) {
    writeCache(scriptPath, args, result, cacheDir);
  }

  return result;
}

/** Raw Python execution without caching */
function execPythonRaw(
  scriptPath: string,
  args: string[],
  stdinData: any,
  pythonCmd: string,
  timeoutMs: number
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const python = spawn(pythonCmd, [scriptPath, ...args]);

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

  const result = await execPython(scriptPath, args, stdinData, 'python3', timeoutMs);

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
