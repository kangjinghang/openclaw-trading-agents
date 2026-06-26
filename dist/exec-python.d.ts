import { ScriptResult } from './types';
/**
 * Auto-detect a Python binary that has the required dependencies.
 * Checks candidates in priority order, caches the first one that works.
 *
 * Priority:
 * 1. TRADING_PYTHON env var (user explicit override)
 * 2. <project>/.venv venv (project-local venv created by setup-python.sh;
 *    preferred so deps installed there win over a system python that lacks them).
 *    Path is platform-specific: win32 → .venv/Scripts/python.exe, else → .venv/bin/python
 * 3. python3 (PATH lookup)
 * 4. python (Windows alias; `python3` may resolve to a bare install there)
 * 5. /usr/bin/python3 (system)
 * 6. /opt/homebrew/bin/python3 (Homebrew macOS)
 * 7. ~/.pyenv/shims/python3 (pyenv)
 *
 * Falls back to 'python3' if none have `requests` installed.
 */
export declare function resolvePythonCmd(): string;
/** Reset the cached Python resolver (for testing) */
export declare function resetPythonResolver(): void;
/** Try to read a cached result. Returns undefined if not found or expired. */
export declare function readCache(scriptPath: string, args: string[], ttlMs?: number, cacheDir?: string): ScriptResult | undefined;
/** Write a successful result to cache */
export declare function writeCache(scriptPath: string, args: string[], result: ScriptResult, cacheDir?: string): void;
/**
 * Execute a Python script and capture its JSON output.
 * Results are cached when `useCache` is true (default).
 * @param scriptPath - Absolute path to the Python script
 * @param args - Command line arguments to pass to the script
 * @param stdinData - Optional data to pass via stdin
 * @param pythonCmd - Python command to use (defaults to resolvePythonCmd(), which
 *                    prefers project .venv then system python — pass explicitly only to override)
 * @param timeoutMs - Timeout in milliseconds
 * @param useCache - Whether to use cache (default: true)
 * @param cacheDir - Override cache directory (default: ~/.openclaw/cache)
 */
export declare function execPython(scriptPath: string, args?: string[], stdinData?: any, pythonCmd?: string, timeoutMs?: number, useCache?: boolean, cacheDir?: string): Promise<ScriptResult>;
/** Raw Python execution without caching (spawns the subprocess, captures
 *  stdout/stderr, parses JSON). Exported so it can be referenced by the
 *  indirection handle below. */
export declare function execPythonRaw(scriptPath: string, args: string[], stdinData: any, pythonCmd: string, timeoutMs: number): Promise<ScriptResult>;
/** Indirection over execPythonRaw so tests can swap `.run` to simulate
 *  transient failures (e.g. a timeout-then-success sequence) without spawning
 *  real subprocesses. execPython calls _execPythonRawHandle.run instead of the
 *  bare execPythonRaw binding because vi.spyOn would only patch the export,
 *  not the local call site — leaving the retry path untestable. Declared as a
 *  mutable object (not reassigned) so test patches persist across the SUT's
 *  reads of .run. */
export declare const _execPythonRawHandle: {
    run: typeof execPythonRaw;
};
/**
 * Execute a skill script from the skills directory
 * @param skillName - Name of the skill (e.g., 'trading-kline')
 * @param scriptName - Name of the script file without .py extension (e.g., 'get-data')
 * @param projectRoot - Root directory of the project
 * @param args - Command line arguments to pass to the script
 * @param stdinData - Optional data to pass via stdin
 * @returns Promise<ScriptResult> - The parsed JSON output with _source field
 */
export declare function execSkillScript(skillName: string, scriptName: string, projectRoot: string, args?: string[], stdinData?: any, timeoutMs?: number): Promise<ScriptResult>;
//# sourceMappingURL=exec-python.d.ts.map