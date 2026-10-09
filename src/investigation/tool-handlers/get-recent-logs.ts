import type { DatabaseSync } from "node:sqlite";
import { GetRecentLogsInputSchema } from "../../agents/schemas.js";
import { getLogEvents } from "../../storage/repositories/log-events.js";
import { getRun } from "../../storage/repositories/runs.js";
import { buildBoundedResult, createContentEvidence, emptyToolResult, type BoundedHandlerResult } from "./evidence.js";

export type LogToolContext = {
  database: DatabaseSync;
  projectId: string;
  activeRunId: string;
  investigationId: string;
  projectRoot: string;
};

export function handleGetRecentLogs(rawInput: unknown, context: LogToolContext): BoundedHandlerResult {
  const input = GetRecentLogsInputSchema.parse(rawInput);
  const runId = input.runId ?? context.activeRunId;
  const run = getRun(context.database, context.projectId, runId);
  if (!run) return emptyToolResult(context.investigationId, "getRecentLogs", "unavailable", "The requested run is unavailable in this project.");

  const rows = getLogEvents(context.database, context.projectId, runId, input.limit + 1);
  if (rows.length === 0) {
    return emptyToolResult(context.investigationId, "getRecentLogs", "empty", "No log events found for the requested run.");
  }
  const hasMore = rows.length > input.limit;
  const recentRows = hasMore ? rows.slice(1) : rows;
  const contentEvidence = recentRows.map((event) => createContentEvidence({
    investigationId: context.investigationId,
    sourceKey: `log:${event.runId}:${event.id}`,
    sourceType: runId === context.activeRunId ? "run_log" : "historical_log",
    excerpt: event.content,
    localRoots: [run.cwd, context.projectRoot],
  }));
  return buildBoundedResult({
    investigationId: context.investigationId,
    toolName: "getRecentLogs",
    contentEvidence,
    toolResult: hasMore || recentRows.length > 5 ? "Only the newest log lines that fit the request and response budget were returned." : undefined,
    outcomeStatus: hasMore || recentRows.length > 5 ? "limited" : "ok",
    safeSummary: "Retrieved recent log lines.",
    preferLastContent: true,
  });
}
