import { TradingAgentsConfig } from "./types";
/** Parsed CLI arguments */
export interface CliArgs {
    mode: "quick" | "full";
    ticker: string;
    date: string;
    config: TradingAgentsConfig;
    format: "json" | "md" | "html";
}
/** Parse CLI arguments into a structured object. Throws on invalid input. */
export declare function parseArgs(argv: string[]): CliArgs;
//# sourceMappingURL=cli.d.ts.map