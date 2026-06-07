// src/exec-python.ts

import { spawn } from 'child_process';
import { ScriptResult } from './types';
import { PYTHON_SCRIPT_TIMEOUT_MS } from './constants';

/**
 * Execute a Python script and capture its JSON output
 * @param scriptPath - Absolute path to the Python script
 * @param args - Command line arguments to pass to the script
 * @param stdinData - Optional data to pass via stdin
 * @param pythonCmd - Python command to use (defaults to 'python3')
 * @returns Promise<ScriptResult> - The parsed JSON output or error information
 */
export async function execPython(
  scriptPath: string,
  args: string[] = [],
  stdinData: any = null,
  pythonCmd: string = 'python3',
  timeoutMs: number = PYTHON_SCRIPT_TIMEOUT_MS
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

    // Handle stdin input
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
        const data = JSON.parse(stdout.trim());
        resolve({
          success: true,
          data
        });
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