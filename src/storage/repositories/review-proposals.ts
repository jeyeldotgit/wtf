import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DiagnosisSchema, type Diagnosis } from '../../agents/schemas.js';
import { hashContent, snapshotFiles, type FileSnapshot } from '../../approvals/files.js';
import { withTransaction } from '../database.js';

export type FixReview = {
  id: string;
  investigationId: string;
  summary: string;
  files: NonNullable<Diagnosis['proposedFix']>['files'];
  snapshots: FileSnapshot[];
  appliedSnapshots: FileSnapshot[] | null;
  appliedAt: number | null;
  hash: string;
  status: string;
  error: string | null;
};
export type CommandReview = {
  id: string;
  investigationId: string;
  command: string;
  reason: string;
  hash: string;
  status: string;
};
export type ReviewProposals = { patch?: FixReview; command?: CommandReview };

export const fixHash = (investigationId: string, summary: string, files: FixReview['files'], snapshots: FileSnapshot[]): string =>
  hashContent(JSON.stringify({ investigationId, summary, files, snapshots }));
export const commandHash = (investigationId: string, command: string, reason: string): string =>
  hashContent(JSON.stringify({ investigationId, command, reason }));

/** Called once when a validated diagnosis is saved; never refresh a stale baseline silently. */
export function persistReviewProposals(database: DatabaseSync, investigationId: string, root: string, raw: Diagnosis): void {
  const diagnosis = DiagnosisSchema.parse(raw);
  if (diagnosis.missingInformation.length) return;
  const now = new Date().toISOString();
  const fix = diagnosis.proposedFix;
  let snapshots: FileSnapshot[] = [];
  let error: string | null = null;
  if (fix) {
    try { snapshots = snapshotFiles(root, fix.files); }
    catch { error = 'The patch targets could not be safely snapshotted. Request a fresh diagnosis.'; }
  }
  withTransaction(database, () => {
    if (fix) database.prepare(`INSERT OR IGNORE INTO fix_proposals
      (id, investigation_id, summary, files_json, snapshots_json, content_hash, status, error_summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`)
      .run(randomUUID(), investigationId, fix.summary, JSON.stringify(fix.files), JSON.stringify(snapshots), fixHash(investigationId, fix.summary, fix.files, snapshots), error, now, now);
    const command = diagnosis.verificationCommand;
    if (command) database.prepare(`INSERT OR IGNORE INTO command_proposals
      (id, investigation_id, command, reason, content_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?)`)
      .run(randomUUID(), investigationId, command.command, command.reason, commandHash(investigationId, command.command, command.reason), now, now);
  });
}

export function getFixReview(database: DatabaseSync, projectId: string, id: string): FixReview | undefined {
  const row = database.prepare(`SELECT p.* FROM fix_proposals p JOIN investigations i ON i.id = p.investigation_id
    WHERE p.id = ? AND i.project_id = ? AND p.content_hash IS NOT NULL`).get(id, projectId) as Record<string, string | null> | undefined;
  if (!row) return undefined;
  return { id: String(row.id), investigationId: String(row.investigation_id), summary: String(row.summary),
    files: JSON.parse(String(row.files_json)), snapshots: JSON.parse(String(row.snapshots_json)), appliedSnapshots: row.applied_snapshots_json ? JSON.parse(row.applied_snapshots_json) : null,
    appliedAt: row.status === 'applied' ? Date.parse(String(row.updated_at)) : null, hash: String(row.content_hash), status: String(row.status), error: row.error_summary };
}

export function getCommandReview(database: DatabaseSync, projectId: string, id: string): CommandReview | undefined {
  const row = database.prepare(`SELECT p.* FROM command_proposals p JOIN investigations i ON i.id = p.investigation_id
    WHERE p.id = ? AND i.project_id = ? AND p.content_hash IS NOT NULL`).get(id, projectId) as Record<string, string> | undefined;
  return row ? { id: row.id, investigationId: row.investigation_id, command: row.command, reason: row.reason, hash: row.content_hash, status: row.status } : undefined;
}

export function getReviewProposals(database: DatabaseSync, projectId: string, investigationId: string): ReviewProposals {
  const fix = database.prepare('SELECT id FROM fix_proposals WHERE investigation_id = ? AND content_hash IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1').get(investigationId) as { id: string } | undefined;
  const command = database.prepare('SELECT id FROM command_proposals WHERE investigation_id = ? AND content_hash IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1').get(investigationId) as { id: string } | undefined;
  return { patch: fix ? getFixReview(database, projectId, fix.id) : undefined, command: command ? getCommandReview(database, projectId, command.id) : undefined };
}

export function declineProposal(database: DatabaseSync, projectId: string, kind: 'patch' | 'command', id: string, approvedHash: string): void {
  const proposal = kind === 'patch' ? getFixReview(database, projectId, id) : getCommandReview(database, projectId, id);
  if (!proposal || proposal.hash !== approvedHash || proposal.status !== 'proposed') throw new Error('This proposal is no longer available.');
  const table = kind === 'patch' ? 'fix_proposals' : 'command_proposals';
  const now = new Date().toISOString();
  database.prepare(`UPDATE ${table} SET status = 'rejected', decision_at = ?, updated_at = ? WHERE id = ? AND status = 'proposed'`).run(now, now, id);
}
