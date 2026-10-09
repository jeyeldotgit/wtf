import { randomUUID } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { DiagnosisSchema } from '../agents/schemas.js';
import { redactSecrets } from '../shared/redaction.js';
import { getInvestigation } from '../storage/repositories/investigations.js';
import { fixHash, getFixReview } from '../storage/repositories/review-proposals.js';
import { hashContent, readTarget } from './files.js';
import { applyUnifiedDiff } from './unified-diff.js';
import { sanitizeDiffText } from '../shared/terminal-text.js';
import type { PatchApprovalState } from '../ui/types/index.js';

export type PatchResult = Extract<PatchApprovalState, { status: 'patch_applied' | 'stale_patch' | 'patch_failed' }>;
export type ApprovalContext = { database: DatabaseSync; projectId: string; projectRoot: string; approvalHash: string };

/** The caller supplies the token from the preview only after an explicit Apply action. */
export async function applyApprovedPatch(proposalId: string, context: ApprovalContext): Promise<PatchResult> {
  const { database, projectId, projectRoot, approvalHash } = context;
  let claimed = false;
  const temporary: string[] = [];
  const written: { path: string; before: Buffer | null; after: string | null; mode: number }[] = [];
  try {
    const proposal = getFixReview(database, projectId, proposalId);
    if (!proposal || proposal.status !== 'proposed') throw new Error('This patch is no longer awaiting approval.');
    const diagnosisRecord = getInvestigation(database, projectId, proposal.investigationId);
    const diagnosis = DiagnosisSchema.parse(JSON.parse(diagnosisRecord?.diagnosis ?? 'null'));
    if (diagnosis.missingInformation.length || diagnosisRecord?.status !== 'awaiting_patch_approval') throw new Error('This diagnosis does not allow patch approval.');
    if (proposal.hash !== approvalHash || proposal.hash !== fixHash(proposal.investigationId, proposal.summary, proposal.files, proposal.snapshots)
      || JSON.stringify(proposal.files) !== JSON.stringify(diagnosis.proposedFix?.files)
      || proposal.summary !== diagnosis.proposedFix?.summary) {
      throw new StalePatch('The saved proposal changed. Request a fresh preview and approve it again.');
    }
    if (proposal.error || proposal.snapshots.length !== proposal.files.length) throw new Error(proposal.error ?? 'The patch has no valid file snapshots.');
    if (proposal.files.some(file => redactSecrets(file.diff) !== file.diff || file.diff.includes('[REDACTED_SECRET]') || sanitizeDiffText(file.diff, [projectRoot]) !== file.diff)) {
      throw new Error('The patch contains secrets or redacted placeholders. Request a safe replacement.');
    }
    const plans = proposal.files.map((file, index) => {
      const target = readTarget(projectRoot, file.path);
      const snapshot = proposal.snapshots[index];
      if (snapshot.path !== file.path || snapshot.hash !== (target.content === null ? null : hashContent(target.content))) {
        throw new StalePatch('A target file changed since diagnosis. Request a fresh diagnosis before applying.');
      }
      const after = applyUnifiedDiff(target.content?.toString('utf8') ?? null, file.diff, file.path);
      return { ...target, path: file.path, after, mode: target.content === null ? 0o644 : statSync(target.absolute).mode };
    });
    database.exec('BEGIN IMMEDIATE');
    claimed = true;
    const claim = database.prepare(`UPDATE fix_proposals SET status = 'approved', decision_at = ?, updated_at = ?
      WHERE id = ? AND status = 'proposed' AND content_hash = ?`).run(new Date().toISOString(), new Date().toISOString(), proposalId, approvalHash);
    if (claim.changes !== 1) throw new Error('This patch has already been decided.');
    for (const plan of plans) {
      if (plan.after !== null) {
        const temp = `${plan.absolute}.wtf-patch-${randomUUID()}`;
        temporary.push(temp);
        writeFileSync(temp, plan.after, { flag: 'wx', mode: plan.mode });
      } else temporary.push('');
    }
    for (let index = 0; index < plans.length; index++) {
      const plan = plans[index];
      const current = readTarget(projectRoot, plan.path);
      if ((current.content === null ? null : hashContent(current.content)) !== (plan.content === null ? null : hashContent(plan.content))) {
        throw new StalePatch('A target changed during application. Request a fresh preview.');
      }
      if (plan.after === null) unlinkSync(plan.absolute);
      else renameSync(temporary[index], plan.absolute);
      written.push({ path: plan.path, before: plan.content, after: plan.after, mode: plan.mode });
    }
    const appliedAt = Date.now();
    database.prepare(`UPDATE fix_proposals SET status = 'applied', applied_snapshots_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(plans.map(plan => ({ path: plan.path, hash: plan.after === null ? null : hashContent(plan.after) }))), new Date(appliedAt).toISOString(), proposalId);
    database.exec('COMMIT');
    claimed = false;
    return { status: 'patch_applied', proposalId, appliedAt };
  } catch (error) {
    let rollbackFailed = false;
    for (const file of written.reverse()) {
      try {
        const current = readTarget(projectRoot, file.path);
        if ((current.content === null ? null : hashContent(current.content)) !== (file.after === null ? null : hashContent(file.after))) throw new Error();
        if (file.before === null) unlinkSync(current.absolute);
        else writeFileSync(current.absolute, file.before, { mode: file.mode });
      } catch { rollbackFailed = true; }
    }
    if (claimed) database.exec('ROLLBACK');
    const stale = error instanceof StalePatch && !rollbackFailed;
    const message = rollbackFailed ? 'Patch failed and some files could not be restored. Review the working tree before retrying.'
      : error instanceof StalePatch ? error.message : 'The patch could not be safely applied. Review the proposal and request a fresh diagnosis.';
    database.prepare(`UPDATE fix_proposals SET status = ?, error_summary = ?, decision_at = ?, updated_at = ?
      WHERE id = ? AND status = 'proposed' AND investigation_id IN (SELECT id FROM investigations WHERE project_id = ?)`)
      .run(stale ? 'stale' : 'rejected', message, new Date().toISOString(), new Date().toISOString(), proposalId, projectId);
    return stale ? { status: 'stale_patch', proposalId, reason: message } : { status: 'patch_failed', proposalId, error: message };
  } finally {
    for (const temp of temporary) if (temp) { try { unlinkSync(temp); } catch {} }
  }
}

class StalePatch extends Error {}
