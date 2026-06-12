import * as http from "http";
declare function parseDashboardArgs(argv: string[]): {
    port: number;
    reportDir: string;
};
/** Serve the dashboard */
export declare function startServer(reportDir: string, port: number): http.Server;
export { parseDashboardArgs };
//# sourceMappingURL=dashboard.d.ts.map