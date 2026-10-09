import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export function createCommandProposalPlaceholder(database: DatabaseSync, investigationId: string, createdAt = new Date().toISOString()): string {
  const id = randomUUID();
  database.prepare(`
    INSERT INTO command_proposals (id, investigation_id, command, reason, status, created_at, updated_at)
    VALUES (?, ?, '', '', 'proposed', ?, ?)
  `).run(id, investigationId, createdAt, createdAt);
  return id;
}
