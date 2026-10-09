import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RunAgentEvidenceSchema, type RunAgentEvidence } from "../../agents/schemas.js";

export function persistEvidence(database: DatabaseSync, investigationId: string, rawEvidence: unknown): RunAgentEvidence {
  const evidence = RunAgentEvidenceSchema.parse(rawEvidence);
  const contentHash = createHash("sha256").update(evidence.excerpt).digest("hex");
  const existing = database.prepare(`
    SELECT content_hash FROM investigation_evidence WHERE investigation_id = ? AND id = ?
  `).get(investigationId, evidence.id) as { content_hash: string } | undefined;
  if (existing && existing.content_hash !== contentHash) {
    throw new Error("Evidence id collision with different content");
  }
  database.prepare(`
    INSERT INTO investigation_evidence
      (id, investigation_id, source_type, source_id, excerpt, content_hash, relative_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(investigation_id, id) DO NOTHING
  `).run(
    evidence.id,
    investigationId,
    evidence.sourceType,
    evidence.id,
    evidence.excerpt,
    contentHash,
    evidence.relativePath ?? null,
    new Date().toISOString(),
  );
  return evidence;
}

export function listEvidence(database: DatabaseSync, investigationId: string): RunAgentEvidence[] {
  const rows = database.prepare(`
    SELECT id, source_type, relative_path, excerpt
    FROM investigation_evidence WHERE investigation_id = ? ORDER BY created_at, id
  `).all(investigationId) as Array<Record<string, string | null>>;
  return rows.map((row) => RunAgentEvidenceSchema.parse({
    id: row.id,
    sourceType: row.source_type,
    relativePath: row.relative_path ?? undefined,
    excerpt: row.excerpt,
  }));
}
