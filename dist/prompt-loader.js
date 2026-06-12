"use strict";
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
exports.renderTemplate = renderTemplate;
exports.loadPrompt = loadPrompt;
exports.loadAndRender = loadAndRender;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Render a template by replacing {{key}} placeholders with values.
 * Missing keys are left as-is.
 */
function renderTemplate(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return vars.hasOwnProperty(key) ? vars[key] : match;
    });
}
/**
 * Load a prompt template file from the prompts directory.
 * Paths are resolved relative to skills/trading-analysis/prompts/ by default.
 */
function loadPrompt(promptPath, baseDir) {
    const defaultBaseDir = path.join(process.cwd(), "skills", "trading-analysis", "prompts");
    const resolvedBaseDir = baseDir || defaultBaseDir;
    const fullPath = path.resolve(resolvedBaseDir, promptPath);
    return fs.readFileSync(fullPath, "utf-8");
}
/**
 * Load and render a prompt template in one call.
 */
function loadAndRender(promptPath, vars, baseDir) {
    const template = loadPrompt(promptPath, baseDir);
    return renderTemplate(template, vars);
}
//# sourceMappingURL=prompt-loader.js.map