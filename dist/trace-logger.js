"use strict";
// src/trace-logger.ts
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
exports.TraceLogger = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class TraceLogger {
    constructor(traceDir, runId = "") {
        this.counter = 0;
        this._totalTokens = 0;
        this._totalCostUsd = 0;
        this._warnings = [];
        this.traceDir = traceDir;
        this._runId = runId;
        fs.mkdirSync(traceDir, { recursive: true });
    }
    /** Record a single LLM call trace to disk as JSON, enriching with run_id */
    record(trace) {
        const enriched = { ...trace, run_id: this._runId };
        // Lead the filename with the role so the trace dir is browsable
        // ("which file is the trader?" → scan the prefix). call_index is NOT
        // unique within a run (parallel calls read traceLogger.count before
        // record() increments it), so uniqueness comes from trace_id, never
        // from index — two traces sharing role+index still get distinct files.
        const filePath = path.join(this.traceDir, `${trace.role}-${trace.trace_id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(enriched, null, 2), "utf-8");
        this.counter++;
        this._totalTokens += trace.meta.usage.total_tokens;
        this._totalCostUsd += trace.meta.cost_usd;
    }
    /** Get number of traces recorded */
    get count() {
        return this.counter;
    }
    /** Get accumulated total tokens across all traces */
    get totalTokens() {
        return this._totalTokens;
    }
    /** Get accumulated total cost in USD across all traces */
    get totalCostUsd() {
        return this._totalCostUsd;
    }
    /** Get the run ID */
    get runId() {
        return this._runId;
    }
    /**
     * Record a silent fallback that fired (parse → default/synonym/alternative).
     * `severity` defaults to "warn"; pass "error" for dangerous defaults like
     * risk → "pass" or a numeric field falling to 0. Kept on the TraceLogger so
     * warnings share the run's lifecycle without threading a collector through
     * every pure parse function.
     */
    recordWarning(warning) {
        this._warnings.push({ severity: "warn", ...warning });
    }
    /** Get all fallback warnings recorded this run */
    get warnings() {
        return this._warnings;
    }
}
exports.TraceLogger = TraceLogger;
//# sourceMappingURL=trace-logger.js.map