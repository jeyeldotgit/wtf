import type { DatabaseSync } from "node:sqlite";
import { SearchLogsInputSchema } from "../../agents/schemas.js";
import { searchLogEvents } from "../../storage/repositories/log-events.js";
import { getRun } from "../../storage/repositories/runs.js";
import { redactForStorageOrModel } from "../../shared/redaction.js";
import { buildBoundedResult, centeredExcerpt, createContentEvidence, emptyToolResult, type BoundedHandlerResult } from "./evidence.js";
import type { LogToolContext } from "./get-recent-logs.js";

export function handleSearchLogs(rawInput: unknown, context: LogToolContext): BoundedHandlerResult {
  const input = SearchLogsInputSchema.parse(rawInput);
  const query = redactForStorageOrModel(input.query, [context.projectRoot]);
  const rows = searchLogEvents(context.database, {
    projectId: context.projectId,
    query,
    runId: input.runId,
    limit: input.limit,
  });
  if (rows.length === 0) {
    return emptyToolResult(context.investigationId, "searchLogs", "empty", "No matching log events were found in this project.");
  }

  const hasMore = rows.length > input.limit;
  const contentEvidence = rows.slice(0, input.limit).map((event) => {
    const run = getRun(context.database, context.projectId, event.runId);
    return createContentEvidence({
      investigationId: context.investigationId,
      sourceKey: `search:${event.runId}:${event.id}:${query}`,
      sourceType: event.runId === context.activeRunId ? "run_log" : "historical_log",
      excerpt: centeredExcerpt(event.content, query),
      localRoots: [run?.cwd ?? "", context.projectRoot],
    });
  });
  return buildBoundedResult({
    investigationId: context.investigationId,
    toolName: "searchLogs",
    contentEvidence,
    toolResult: hasMore ? "More matching log events exist; additional matches were omitted." : undefined,
    outcomeStatus: hasMore ? "limited" : "ok",
    safeSummary: "Searched redacted log events in the active project.",
  });
}
