/**
 * Render a template by replacing {{key}} placeholders with values.
 * Missing keys are left as-is.
 */
export declare function renderTemplate(template: string, vars: Record<string, string>): string;
/**
 * Load a prompt template file from the prompts directory.
 * Paths are resolved relative to skills/trading-analysis/prompts/ by default.
 */
export declare function loadPrompt(promptPath: string, baseDir?: string): string;
/**
 * Load and render a prompt template in one call.
 */
export declare function loadAndRender(promptPath: string, vars: Record<string, string>, baseDir?: string): string;
//# sourceMappingURL=prompt-loader.d.ts.map