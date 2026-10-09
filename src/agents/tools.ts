import { tool } from "ai";
import {
  GetProjectContextInputSchema,
  GetRecentLogsInputSchema,
  SearchLogsInputSchema,
} from "./schemas.js";

// These tools intentionally describe capabilities without execute handlers.
// The application handles each validated request after the model call ends.
export const runAgentTools = {
  getRecentLogs: tool({
    description: "Request a small number of recent redacted log excerpts for this failed run. This only creates a request; it does not read logs itself.",
    inputSchema: GetRecentLogsInputSchema,
  }),
  searchLogs: tool({
    description: "Request a bounded search through redacted local run history for a relevant error or phrase. This only creates a request; it does not search history itself.",
    inputSchema: SearchLogsInputSchema,
  }),
  getProjectContext: tool({
    description: "Request a few relevant, non-secret files under the project root, such as package.json, a config file, or a source file. The application must enforce path and content filtering. This only creates a request; it does not read files itself.",
    inputSchema: GetProjectContextInputSchema,
  }),
};
