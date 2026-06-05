import * as fs from "fs";
import * as path from "path";

/**
 * Render a template by replacing {{key}} placeholders with values.
 * Missing keys are left as-is.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return vars.hasOwnProperty(key) ? vars[key] : match;
  });
}

/**
 * Load a prompt template file from the prompts directory.
 * Paths are resolved relative to skills/trading-analysis/prompts/ by default.
 */
export function loadPrompt(promptPath: string, baseDir?: string): string {
  const defaultBaseDir = path.join(process.cwd(), "skills", "trading-analysis", "prompts");
  const resolvedBaseDir = baseDir || defaultBaseDir;
  const fullPath = path.resolve(resolvedBaseDir, promptPath);

  return fs.readFileSync(fullPath, "utf-8");
}

/**
 * Load and render a prompt template in one call.
 */
export function loadAndRender(
  promptPath: string,
  vars: Record<string, string>,
  baseDir?: string
): string {
  const template = loadPrompt(promptPath, baseDir);
  return renderTemplate(template, vars);
}
