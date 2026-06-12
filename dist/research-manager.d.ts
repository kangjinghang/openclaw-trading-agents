import OpenAI from "openai";
import { TraceLogger } from "./trace-logger";
import { TradingAgentsConfig, AnalystReport, DebateResult, ResearchDecision } from "./types";
export declare function runResearchManager(analystReports: AnalystReport[], debate: DebateResult, qualitySummary: string, config: TradingAgentsConfig, openaiClient: OpenAI, traceLogger: TraceLogger): Promise<ResearchDecision>;
//# sourceMappingURL=research-manager.d.ts.map