import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "../database.js";

export type InvestigationStatus =
  | "investigating"
  | "awaiting_user"
  | "diagnosed"
  | "needs_input"
  | "awaiting_patch_approval"
  | "resolved"
  | "dismissed"
  | "failed";

export type InvestigationRecord = {
  id: string;
  projectId: string;
  triggerRunId: string;
  status: InvestigationStatus;
  diagnosis: string | null;
  modelVersion: string | null;
  promptVersion: string | null;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  toolRoundCount: number;
  createdAt: string;
  updatedAt: string;
};

const TRANSITIONS: Record<InvestigationStatus, InvestigationStatus[]> = {
  investigating: ["awaiting_user", "diagnosed", "needs_input", "awaiting_patch_approval", "resolved", "dismissed", "failed"],
  awaiting_user: ["investigating", "diagnosed", "needs_input", "awaiting_patch_approval", "resolved", "dismissed", "failed"],
  diagnosed: [],
  needs_input: ["investigating", "dismissed", "failed"],
  awaiting_patch_approval: ["resolved", "dismissed", "failed"],
  resolved: [],
  dismissed: [],
  failed: ["investigating", "dismissed"],
};

export function createInvestigation(database: DatabaseSync, input: {
  id?: string;
  projectId: string;
  triggerRunId: string;
  status?: InvestigationStatus;
  createdAt?: string;
}): string {
  const id = input.id ?? randomUUID();
  const now = input.createdAt ?? new Date().toISOString();
  const status = input.status ?? "investigating";
  withTransaction(database, () => {
    const run = database.prepare("SELECT id FROM runs WHERE id = ? AND project_id = ?").get(input.triggerRunId, input.projectId);
    if (!run) throw new Error("Trigger run not found in the active project");
    database.prepare(`
      INSERT INTO investigations (id, project_id, trigger_run_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.projectId, input.triggerRunId, status, now, now);
    database.prepare("UPDATE runs SET investigation_id = ? WHERE id = ? AND project_id = ?")
      .run(id, input.triggerRunId, input.projectId);
  });
  return id;
}

export function getInvestigation(database: DatabaseSync, projectId: string, id: string): InvestigationRecord | undefined {
  const row = database.prepare(`
    SELECT id, project_id, trigger_run_id, status, diagnosis, model_version, prompt_version,
      last_error_code, last_error_summary, tool_round_count, created_at, updated_at
    FROM investigations WHERE id = ? AND project_id = ?
  `).get(id, projectId) as Record<string, string | number | null> | undefined;
  return row ? mapInvestigation(row) : undefined;
}

export function getInvestigationByTriggerRun(database: DatabaseSync, projectId: string, triggerRunId: string): InvestigationRecord | undefined {
  const row = database.prepare(`
    SELECT id, project_id, trigger_run_id, status, diagnosis, model_version, prompt_version,
      last_error_code, last_error_summary, tool_round_count, created_at, updated_at
    FROM investigations WHERE trigger_run_id = ? AND project_id = ?
  `).get(triggerRunId, projectId) as Record<string, string | number | null> | undefined;
  return row ? mapInvestigation(row) : undefined;
}

export function transitionInvestigation(database: DatabaseSync, input: {
  id: string;
  projectId: string;
  status: InvestigationStatus;
  diagnosis?: string;
  modelVersion?: string;
  promptVersion?: string;
  errorCode?: string;
  errorSummary?: string;
  toolRoundCount?: number;
  updatedAt?: string;
}): void {
  const current = database.prepare("SELECT status FROM investigations WHERE id = ? AND project_id = ?")
    .get(input.id, input.projectId) as { status: InvestigationStatus } | undefined;
  if (!current) throw new Error("Investigation not found in the active project");
  if (current.status !== input.status && !TRANSITIONS[current.status].includes(input.status)) {
    throw new Error(`Invalid investigation transition: ${current.status} -> ${input.status}`);
  }
  database.prepare(`
    UPDATE investigations
    SET status = ?, diagnosis = COALESCE(?, diagnosis), model_version = COALESCE(?, model_version),
        prompt_version = COALESCE(?, prompt_version), last_error_code = ?, last_error_summary = ?,
        tool_round_count = COALESCE(?, tool_round_count), updated_at = ?
    WHERE id = ? AND project_id = ?
  `).run(
    input.status,
    input.diagnosis ?? null,
    input.modelVersion ?? null,
    input.promptVersion ?? null,
    input.errorCode ?? null,
    input.errorSummary ?? null,
    input.toolRoundCount ?? null,
    input.updatedAt ?? new Date().toISOString(),
    input.id,
    input.projectId,
  );
}

function mapInvestigation(row: Record<string, string | number | null>): InvestigationRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    triggerRunId: String(row.trigger_run_id),
    status: String(row.status) as InvestigationStatus,
    diagnosis: row.diagnosis === null ? null : String(row.diagnosis),
    modelVersion: row.model_version === null ? null : String(row.model_version),
    promptVersion: row.prompt_version === null ? null : String(row.prompt_version),
    lastErrorCode: row.last_error_code === null ? null : String(row.last_error_code),
    lastErrorSummary: row.last_error_summary === null ? null : String(row.last_error_summary),
    toolRoundCount: Number(row.tool_round_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
