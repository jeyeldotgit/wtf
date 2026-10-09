import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "../database.js";

export type InvestigationStatus = "investigating" | "awaiting_user" | "resolved" | "dismissed" | "failed";

const TRANSITIONS: Record<InvestigationStatus, InvestigationStatus[]> = {
  investigating: ["awaiting_user", "resolved", "dismissed", "failed"],
  awaiting_user: ["investigating", "resolved", "dismissed", "failed"],
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

export function transitionInvestigation(database: DatabaseSync, input: {
  id: string;
  projectId: string;
  status: InvestigationStatus;
  diagnosis?: string;
  modelVersion?: string;
  promptVersion?: string;
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
        prompt_version = COALESCE(?, prompt_version), updated_at = ?
    WHERE id = ? AND project_id = ?
  `).run(
    input.status,
    input.diagnosis ?? null,
    input.modelVersion ?? null,
    input.promptVersion ?? null,
    input.updatedAt ?? new Date().toISOString(),
    input.id,
    input.projectId,
  );
}

export function getInvestigation(database: DatabaseSync, projectId: string, id: string): Record<string, unknown> | undefined {
  const row = database.prepare(`
    SELECT id, project_id, trigger_run_id, status, diagnosis, model_version, prompt_version, created_at, updated_at
    FROM investigations WHERE id = ? AND project_id = ?
  `).get(id, projectId);
  return row as Record<string, unknown> | undefined;
}
