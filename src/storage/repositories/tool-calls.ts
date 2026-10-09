import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { redactForStorageOrModel } from "../../shared/redaction.js";

export type ToolName = "getRecentLogs" | "searchLogs" | "getProjectContext" | "invalid";
export type ToolOutcomeStatus = "pending" | "ok" | "empty" | "limited" | "unavailable" | "error";
export type ToolCallRecord = {
  id: string;
  investigationId: string;
  round: number;
  toolName: ToolName;
  requestHash: string;
  requestJson: string;
  outcomeStatus: ToolOutcomeStatus;
  safeSummary: string;
  createdAt: string;
};

export type ToolRequestPayload = {
  toolName: Exclude<ToolName, "invalid">;
  input: unknown;
};

export function hashToolRequest(toolName: string, parsedArguments: unknown): string {
  return createHash("sha256")
    .update(toolName)
    .update(JSON.stringify(parsedArguments) ?? "null")
    .digest("hex");
}

export function recordPendingToolCall(database: DatabaseSync, input: {
  investigationId: string;
  round: number;
  request: ToolRequestPayload;
  localRoots?: string[];
}): { record: ToolCallRecord; created: boolean } {
  const requestHash = hashToolRequest(input.request.toolName, input.request.input);
  const existing = getToolCallByHash(database, input.investigationId, requestHash);
  if (existing) return { record: existing, created: false };

  const id = toolCallId(input.investigationId, requestHash);
  const requestJson = safeRequestJson(input.request.toolName, input.request.input, input.localRoots ?? []);
  database.prepare(`
    INSERT INTO investigation_tool_calls
      (id, investigation_id, round, tool_name, request_hash, request_json, outcome_status, safe_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 'Lookup pending.', ?)
    ON CONFLICT(investigation_id, request_hash) DO NOTHING
  `).run(id, input.investigationId, input.round, input.request.toolName, requestHash, requestJson, new Date().toISOString());

  const record = getToolCallByHash(database, input.investigationId, requestHash);
  if (!record) throw new Error("Pending tool request could not be recorded");
  return { record, created: record.id === id };
}

export function completeToolCall(database: DatabaseSync, input: {
  investigationId: string;
  requestHash: string;
  outcomeStatus: Exclude<ToolOutcomeStatus, "pending">;
  safeSummary: string;
}): void {
  const safeSummary = redactForStorageOrModel(input.safeSummary).slice(0, 240);
  const result = database.prepare(`
    UPDATE investigation_tool_calls
    SET outcome_status = ?, safe_summary = ?
    WHERE investigation_id = ? AND request_hash = ? AND outcome_status = 'pending'
  `).run(input.outcomeStatus, safeSummary, input.investigationId, input.requestHash);
  if (Number(result.changes) > 0) return;

  const existing = getToolCallByHash(database, input.investigationId, input.requestHash);
  if (!existing || existing.outcomeStatus !== input.outcomeStatus || existing.safeSummary !== safeSummary) {
    throw new Error("Pending tool request could not be completed consistently");
  }
}

export function recordToolCall(database: DatabaseSync, input: {
  investigationId: string;
  round: number;
  toolName: ToolName;
  request: unknown;
  outcomeStatus: Exclude<ToolOutcomeStatus, "pending">;
  safeSummary: string;
  localRoots?: string[];
}): string {
  const requestArguments = input.toolName === "invalid" ? null : extractArguments(input.toolName, input.request);
  const requestHash = hashToolRequest(input.toolName, requestArguments);
  const id = toolCallId(input.investigationId, requestHash);
  const requestJson = input.toolName === "invalid"
    ? "{}"
    : safeRequestJson(input.toolName, requestArguments, input.localRoots ?? []);
  database.prepare(`
    INSERT INTO investigation_tool_calls
      (id, investigation_id, round, tool_name, request_hash, request_json, outcome_status, safe_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(investigation_id, request_hash) DO UPDATE SET
      outcome_status = excluded.outcome_status,
      safe_summary = excluded.safe_summary
    WHERE investigation_tool_calls.outcome_status = 'pending'
  `).run(
    id,
    input.investigationId,
    input.round,
    input.toolName,
    requestHash,
    requestJson,
    input.outcomeStatus,
    redactForStorageOrModel(input.safeSummary).slice(0, 240),
    new Date().toISOString(),
  );
  return id;
}

export function getToolCalls(database: DatabaseSync, investigationId: string): ToolCallRecord[] {
  const rows = database.prepare(`
    SELECT id, investigation_id, round, tool_name, request_hash, request_json, outcome_status, safe_summary, created_at
    FROM investigation_tool_calls WHERE investigation_id = ? ORDER BY round, created_at, id
  `).all(investigationId) as Array<Record<string, string | number>>;
  return rows.map(mapToolCall);
}

export function getPendingToolCall(database: DatabaseSync, investigationId: string): ToolCallRecord | undefined {
  const row = database.prepare(`
    SELECT id, investigation_id, round, tool_name, request_hash, request_json, outcome_status, safe_summary, created_at
    FROM investigation_tool_calls WHERE investigation_id = ? AND outcome_status = 'pending'
    ORDER BY round, created_at, id LIMIT 1
  `).get(investigationId) as Record<string, string | number> | undefined;
  return row ? mapToolCall(row) : undefined;
}

function getToolCallByHash(database: DatabaseSync, investigationId: string, requestHash: string): ToolCallRecord | undefined {
  const row = database.prepare(`
    SELECT id, investigation_id, round, tool_name, request_hash, request_json, outcome_status, safe_summary, created_at
    FROM investigation_tool_calls WHERE investigation_id = ? AND request_hash = ?
  `).get(investigationId, requestHash) as Record<string, string | number> | undefined;
  return row ? mapToolCall(row) : undefined;
}

function extractArguments(toolName: string, request: unknown): unknown {
  if (typeof request !== "object" || request === null || !("toolName" in request) || !("input" in request)) return request;
  const wrapped = request as { toolName?: unknown; input?: unknown };
  return wrapped.toolName === toolName ? wrapped.input : request;
}

function safeRequestJson(toolName: string, value: unknown, localRoots: string[]): string {
  return JSON.stringify({ toolName, input: sanitizeValue(value, localRoots) });
}

function sanitizeValue(value: unknown, localRoots: string[]): unknown {
  if (typeof value === "string") return redactForStorageOrModel(value, localRoots);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, localRoots));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sanitizeValue(item, localRoots)]),
  );
}

function toolCallId(investigationId: string, requestHash: string): string {
  return createHash("sha256").update(`${investigationId}:${requestHash}`).digest("hex");
}

function mapToolCall(row: Record<string, string | number>): ToolCallRecord {
  return {
    id: String(row.id),
    investigationId: String(row.investigation_id),
    round: Number(row.round),
    toolName: String(row.tool_name) as ToolName,
    requestHash: String(row.request_hash),
    requestJson: String(row.request_json),
    outcomeStatus: String(row.outcome_status) as ToolOutcomeStatus,
    safeSummary: String(row.safe_summary),
    createdAt: String(row.created_at),
  };
}
