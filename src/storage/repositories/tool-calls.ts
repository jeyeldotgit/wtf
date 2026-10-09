import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ToolOutcomeStatus = "ok" | "empty" | "limited" | "unavailable" | "error";

export function recordToolCall(database: DatabaseSync, input: {
  investigationId: string;
  round: number;
  toolName: "getRecentLogs" | "searchLogs" | "getProjectContext" | "invalid";
  request: unknown;
  outcomeStatus: ToolOutcomeStatus;
  safeSummary: string;
}): string {
  const serializedRequest = JSON.stringify({ toolName: input.toolName, request: input.request }) ?? String(input.request);
  const requestHash = createHash("sha256").update(serializedRequest).digest("hex");
  const id = createHash("sha256").update(`${input.investigationId}:${requestHash}`).digest("hex").slice(0, 80);
  database.prepare(`
    INSERT INTO investigation_tool_calls
      (id, investigation_id, round, tool_name, request_hash, outcome_status, safe_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(investigation_id, request_hash) DO NOTHING
  `).run(id, input.investigationId, input.round, input.toolName, requestHash, input.outcomeStatus, input.safeSummary, new Date().toISOString());
  return id;
}
