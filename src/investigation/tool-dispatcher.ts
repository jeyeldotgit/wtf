import type { DatabaseSync } from "node:sqlite";
import { ToolRequestSchema, type RunAgentEvidence, type ToolRequest } from "../agents/schemas.js";
import { recordToolCall } from "../storage/repositories/tool-calls.js";
import { persistEvidence } from "../storage/repositories/evidence.js";
import { handleGetProjectContext } from "./tool-handlers/get-project-context.js";
import { handleGetRecentLogs } from "./tool-handlers/get-recent-logs.js";
import { handleSearchLogs } from "./tool-handlers/search-logs.js";
import { emptyToolResult, type BoundedHandlerResult } from "./tool-handlers/evidence.js";

export type DispatchContext = {
  database: DatabaseSync;
  projectId: string;
  activeRunId: string;
  investigationId: string;
  projectRoot: string;
  round: number;
};

export type DispatchResult = BoundedHandlerResult & { accepted: boolean };
export type DispatchOptions = { persist?: boolean };

export async function dispatchToolRequest(rawRequest: unknown, context: DispatchContext, options: DispatchOptions = {}): Promise<DispatchResult> {
  const parsed = ToolRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    const invalid = emptyToolResult(
      context.investigationId,
      "toolDispatcher",
      "error",
      "The requested tool or its arguments were invalid; no lookup was performed.",
    );
    if (options.persist !== false) {
      try {
        recordToolCall(context.database, {
          investigationId: context.investigationId,
          round: context.round,
          toolName: "invalid",
          request: rawRequest,
          outcomeStatus: "error",
          safeSummary: invalid.safeSummary,
        });
      } catch {
        // Invalid requests still produce a bounded result when local audit storage is unavailable.
      }
      persistSafely(context, invalid.evidence);
    }
    return { ...invalid, accepted: false };
  }

  const request = parsed.data;
  let result: BoundedHandlerResult;
  try {
    result = await callHandler(request, context);
  } catch {
    result = emptyToolResult(
      context.investigationId,
      request.toolName,
      "unavailable",
      "The requested local lookup is unavailable; no project changes were made.",
    );
  }

  if (options.persist !== false) {
    try {
      recordToolCall(context.database, {
        investigationId: context.investigationId,
        round: context.round,
        toolName: request.toolName,
        request,
        outcomeStatus: result.outcomeStatus,
        safeSummary: result.safeSummary,
        localRoots: [context.projectRoot],
      });
    } catch {
      // A failed audit write must not leak database details into the agent response.
    }
    persistSafely(context, result.evidence);
  }
  return { ...result, accepted: true };
}

async function callHandler(request: ToolRequest, context: DispatchContext): Promise<BoundedHandlerResult> {
  switch (request.toolName) {
    case "getRecentLogs":
      return handleGetRecentLogs(request.input, context);
    case "searchLogs":
      return handleSearchLogs(request.input, context);
    case "getProjectContext":
      return handleGetProjectContext(request.input, context);
  }
}

function persistSafely(context: DispatchContext, evidence: RunAgentEvidence[]): void {
  for (const item of evidence) {
    try {
      persistEvidence(context.database, context.investigationId, item);
    } catch {
      // The returned bounded result remains usable even when local history is temporarily read-only.
    }
  }
}
