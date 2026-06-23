"use strict";
// src/exec-python.ts
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports._execPythonRawHandle = void 0;
exports.resolvePythonCmd = resolvePythonCmd;
exports.resetPythonResolver = resetPythonResolver;
exports.readCache = readCache;
exports.writeCache = writeCache;
exports.execPython = execPython;
exports.execPythonRaw = execPythonRaw;
exports.execSkillScript = execSkillScript;
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const constants_1 = require("./constants");
// ── Python resolver ─────────────────────────────────────────────────
/** Cached resolved Python command */
let resolvedPython = null;
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
function resolvePythonCmd() {
    if (resolvedPython)
        return resolvedPython;
    const candidates = [
        process.env.TRADING_PYTHON,
        'python3',
        'python', // Windows: `python` is the common alias; `python3` may resolve to a bare install
        '/usr/bin/python3',
        '/opt/homebrew/bin/python3',
        path.join(os.homedir(), '.pyenv/shims/python3'),
    ].filter(Boolean);
    // Two-phase dependency check:
    // Phase 1 (preferred): find a python with ALL deps (requests + akshare + pandas).
    //   This avoids picking a bare system python3 that shadows the uv-managed python
    //   where akshare/pandas are installed (observed: fundamentals financial_health
    //   silently degraded to "No module named 'akshare'").
    // Phase 2 (fallback): if no candidate has all deps, accept requests-only (original
    //   behavior) so environments without akshare still work — akshare-dependent
    //   features degrade gracefully.
    const tryResolve = (deps) => {
        for (const cmd of candidates) {
            try {
                (0, child_process_1.execSync)(`${cmd} -c "${deps}"`, {
                    timeout: 5000,
                    stdio: 'pipe',
                    env: { ...process.env, PYTHONUTF8: '1' },
                });
                return cmd;
            }
            catch {
                // try next candidate
            }
        }
        return null;
    };
    const full = tryResolve('import requests, akshare, pandas');
    if (full) {
        resolvedPython = full;
        console.error(`[exec-python] resolved python: ${full}`);
        return full;
    }
    const minimal = tryResolve('import requests');
    if (minimal) {
        resolvedPython = minimal;
        console.error(`[exec-python] resolved python: ${minimal} (akshare/pandas missing — some features degrade)`);
        return minimal;
    }
    // No candidate has even requests — fallback to bare python3
    resolvedPython = 'python3';
    console.error('[exec-python] no python with requests found, falling back to python3');
    return 'python3';
}
/** Reset the cached Python resolver (for testing) */
function resetPythonResolver() {
    resolvedPython = null;
}
// ── Cache helpers ──────────────────────────────────────────────────
/** Compute a cache key from script path + args */
function cacheKey(scriptPath, args) {
    const raw = `${scriptPath} ${args.join(' ')}`;
    return (0, crypto_1.createHash)('sha256').update(raw).digest('hex').slice(0, 24);
}
/** Resolve cache directory, creating it if needed */
function ensureCacheDir(cacheDir) {
    const dir = (cacheDir || constants_1.DEFAULT_CACHE_DIR).replace('~', os.homedir());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
/** Try to read a cached result. Returns undefined if not found or expired. */
function readCache(scriptPath, args, ttlMs = constants_1.CACHE_TTL_MS, cacheDir) {
    try {
        const dir = ensureCacheDir(cacheDir);
        const filePath = path.join(dir, cacheKey(scriptPath, args) + '.json');
        if (!fs.existsSync(filePath))
            return undefined;
        const entry = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (Date.now() - entry.timestamp > ttlMs)
            return undefined;
        return entry.result;
    }
    catch {
        return undefined;
    }
}
/** Write a successful result to cache */
function writeCache(scriptPath, args, result, cacheDir) {
    if (!result.success)
        return;
    try {
        const dir = ensureCacheDir(cacheDir);
        const filePath = path.join(dir, cacheKey(scriptPath, args) + '.json');
        const entry = { timestamp: Date.now(), result };
        const tmpPath = filePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(entry), 'utf-8');
        fs.renameSync(tmpPath, filePath);
    }
    catch {
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
async function execPython(scriptPath, args = [], stdinData = null, pythonCmd = 'python3', timeoutMs = constants_1.PYTHON_SCRIPT_TIMEOUT_MS, useCache = true, cacheDir) {
    // Check cache first
    if (useCache && stdinData === null) {
        const cached = readCache(scriptPath, args, constants_1.CACHE_TTL_MS, cacheDir);
        if (cached) {
            console.error(`  [cache] hit: ${path.basename(scriptPath)} ${args.join(' ')}`);
            return cached;
        }
    }
    // Call through the indirection handle so tests can swap _execPythonRawHandle.run
    // to simulate transient failures (a direct call to the bare execPythonRaw
    // binding cannot be intercepted by vi.spyOn, which patches the export only).
    let result = await exports._execPythonRawHandle.run(scriptPath, args, stdinData, pythonCmd, timeoutMs);
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
        result = await exports._execPythonRawHandle.run(scriptPath, args, stdinData, pythonCmd, timeoutMs);
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
function execPythonRaw(scriptPath, args, stdinData, pythonCmd, timeoutMs) {
    return new Promise((resolve) => {
        // PYTHONUTF8=1 + -X utf8 force Python 3.7+ to use UTF-8 for stdout/stderr.
        // On Windows, Python defaults to the system locale (GBK for zh-CN),
        // which garbles Chinese characters when Node decodes as UTF-8.
        // On Linux/macOS this is a no-op (already UTF-8).
        // Both the env var AND the CLI flag are needed: the env var covers
        // child processes / library code; the flag covers the main interpreter's
        // stdin/stdout encoding (env var alone can miss the pipe case on Windows).
        const python = (0, child_process_1.spawn)(pythonCmd, ['-X', 'utf8', scriptPath, ...args], {
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
            }
            catch (error) {
                resolve({
                    success: false,
                    error: `Failed to write to stdin: ${error instanceof Error ? error.message : String(error)}`
                });
                python.kill();
                return;
            }
        }
        else {
            python.stdin.end();
        }
        python.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        python.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        python.on('close', (code) => {
            if (resolved)
                return;
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
                const result = {
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
                // Pass through per-source call results (success + failure) emitted by
                // http_helpers.record_call() → output_json() `_calls`. Preferred over
                // `errors` for computing per-source success rates (data-source health
                // tracker; see docs/superpowers/specs/2026-06-15-data-source-health-design.md).
                if (Array.isArray(raw._calls)) {
                    result.calls = raw._calls;
                }
                resolve(result);
            }
            catch (error) {
                resolve({
                    success: false,
                    error: `Failed to parse JSON output: ${error instanceof Error ? error.message : String(error)}. Raw output: ${stdout}`
                });
            }
        });
        python.on('error', (error) => {
            if (resolved)
                return;
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
exports._execPythonRawHandle = { run: execPythonRaw };
/**
 * Execute a skill script from the skills directory
 * @param skillName - Name of the skill (e.g., 'trading-kline')
 * @param scriptName - Name of the script file without .py extension (e.g., 'get-data')
 * @param projectRoot - Root directory of the project
 * @param args - Command line arguments to pass to the script
 * @param stdinData - Optional data to pass via stdin
 * @returns Promise<ScriptResult> - The parsed JSON output with _source field
 */
async function execSkillScript(skillName, scriptName, projectRoot, args = [], stdinData = null, timeoutMs = constants_1.PYTHON_SCRIPT_TIMEOUT_MS) {
    const scriptPath = `${projectRoot}/skills/${skillName}/scripts/${scriptName}.py`;
    const result = await execPython(scriptPath, args, stdinData, resolvePythonCmd(), timeoutMs);
    // Add source information to result
    if (result.success) {
        result._source = `${skillName}:${scriptName}`;
    }
    else {
        // Improve error message for script not found
        if (result.error?.includes('No such file or directory')) {
            result.error = `Script not found: ${scriptPath}`;
        }
    }
    return result;
}
//# sourceMappingURL=exec-python.js.map