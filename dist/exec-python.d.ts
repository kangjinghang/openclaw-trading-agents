import { ScriptResult } from './types';
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
 * @param pythonCmd - Python command to use (defaults to 'python3')
 * @param timeoutMs - Timeout in milliseconds
 * @param useCache - Whether to use cache (default: true)
 * @param cacheDir - Override cache directory (default: ~/.openclaw/cache)
 */
export declare function execPython(scriptPath: string, args?: string[], stdinData?: any, pythonCmd?: string, timeoutMs?: number, useCache?: boolean, cacheDir?: string): Promise<ScriptResult>;
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