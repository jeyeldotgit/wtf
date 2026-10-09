import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export function createFixProposalPlaceholder(database: DatabaseSync, investigationId: string, createdAt = new Date().toISOString()): string {
  const id = randomUUID();
  database.prepare(`
    INSERT INTO fix_proposals (id, investigation_id, summary, files_json, status, created_at, updated_at)
    VALUES (?, ?, '', '[]', 'proposed', ?, ?)
  `).run(id, investigationId, createdAt, createdAt);
  return id;
}
