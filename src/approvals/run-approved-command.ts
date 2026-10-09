import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { DiagnosisSchema, type RunAgentEvidence } from '../agents/schemas.js';
import { sanitizeTerminalText } from '../shared/terminal-text.js';
import { getInvestigation } from '../storage/repositories/investigations.js';
import { getRun } from '../storage/repositories/runs.js';
import { commandHash, fixHash, getCommandReview, getReviewProposals } from '../storage/repositories/review-proposals.js';
import { hashContent, readTarget } from './files.js';
import { persistEvidence } from '../storage/repositories/evidence.js';
import type { RunSessionResult } from '../session/run-session.js';
import type { CommandApprovalState, PatchApprovalState } from '../ui/types/index.js';
import type { ApprovalContext } from './apply-approved-patch.js';

export type CommandResult = Extract<CommandApprovalState, { status: 'verification_success' | 'verification_failure' | 'command_failed' }> | Extract<PatchApprovalState, { status: 'stale_patch' }>;
export type CommandApprovalContext = ApprovalContext & {
  currentCwd: string;
  /** Must persist the captured run and enforce these limits; must not investigate yet. */
  execute: (command: string, options: { investigate: false; timeoutMs: number; maxOutputBytes: number }) => Promise<RunSessionResult | undefined>;
  investigate: (result: RunSessionResult, evidence: RunAgentEvidence[]) => Promise<void>;
};

export async function runApprovedCommand(proposalId: string, context: CommandApprovalContext): Promise<CommandResult> {
  const { database, projectId, approvalHash } = context;
  let claimed = false;
  try {
    const proposal = getCommandReview(database, projectId, proposalId);
    if (!proposal || proposal.status !== 'proposed') throw new Error('This command has already been decided.');
    const investigation = getInvestigation(database, projectId, proposal.investigationId);
    const diagnosis = DiagnosisSchema.parse(JSON.parse(investigation?.diagnosis ?? 'null'));
    const run = investigation ? getRun(database, projectId, investigation.triggerRunId) : undefined;
    if (!run || diagnosis.missingInformation.length || !['diagnosed', 'awaiting_patch_approval'].includes(investigation!.status)) throw new Error('This diagnosis does not allow command approval.');
    if (proposal.hash !== approvalHash || proposal.hash !== commandHash(proposal.investigationId, proposal.command, proposal.reason)
      || proposal.command !== diagnosis.verificationCommand?.command || proposal.reason !== diagnosis.verificationCommand.reason) {
      throw new Error('The command changed after preview. Request a fresh diagnosis and approve again.');
    }
    const currentDirectory = statSync(context.currentCwd);
    const originalDirectory = statSync(run.cwd);
    if (currentDirectory.dev !== originalDirectory.dev || currentDirectory.ino !== originalDirectory.ino) throw new Error('The shell directory changed. Request a fresh diagnosis in this directory before approving.');
    if (sanitizeTerminalText(proposal.command, [context.projectRoot, run.cwd]) !== proposal.command || proposal.command.includes('[REDACTED_SECRET]')) {
      throw new Error('The command cannot be displayed exactly and safely. Request a replacement.');
    }
    const patch = getReviewProposals(database, projectId, proposal.investigationId).patch;
    if (patch) {
      const snapshots = patch.status === 'applied' ? patch.appliedSnapshots : patch.snapshots;
      let stale = patch.status === 'stale' || !snapshots || snapshots.length !== patch.files.length
        || patch.hash !== fixHash(patch.investigationId, patch.summary, patch.files, patch.snapshots);
      try {
        stale ||= snapshots!.some(snapshot => {
          const target = readTarget(context.projectRoot, snapshot.path);
          return snapshot.hash !== (target.content === null ? null : hashContent(target.content));
        });
      } catch { stale = true; }
      if (stale) {
        const reason = 'A patch target changed after preview. Request a fresh diagnosis and approve again.';
        database.prepare(`UPDATE fix_proposals SET status = 'stale', error_summary = ?, updated_at = ? WHERE id = ?`).run(reason, new Date().toISOString(), patch.id);
        return { status: 'stale_patch', proposalId: patch.id, reason };
      }
    }
    const now = new Date().toISOString();
    const claim = database.prepare(`UPDATE command_proposals SET status = 'approved', decision_at = ?, updated_at = ?
      WHERE id = ? AND status = 'proposed' AND content_hash = ?`).run(now, now, proposalId, approvalHash);
    if (claim.changes !== 1) throw new Error('The command has already been decided.');
    claimed = true;
    const result = await context.execute(proposal.command, { investigate: false, timeoutMs: 60_000, maxOutputBytes: 1_000_000 });
    if (!result) throw new Error('The command did not produce a captured run.');
    const exitCode = result.run.exitCode ?? 125;
    const stdout = sanitizeTerminalText(result.captured.stdout, [context.projectRoot, result.run.cwd]);
    const stderr = sanitizeTerminalText(result.captured.stderr, [context.projectRoot, result.run.cwd]);
    const output = `stdout:\n${stdout}\nstderr:\n${stderr}`;
    database.prepare(`UPDATE command_proposals SET status = ?, run_id = ?, updated_at = ? WHERE id = ? AND status = 'approved'`)
      .run(exitCode === 0 ? 'executed' : 'failed', result.run.id, new Date().toISOString(), proposalId);
    if (exitCode !== 0) {
      const evidence: RunAgentEvidence = {
        id: `ev_verification_${randomUUID()}`,
        sourceType: 'run_log',
        excerpt: `Approved verification: ${proposal.command}\nExit status: ${exitCode}\n${output}`.slice(0, 4000),
      };
      persistEvidence(database, proposal.investigationId, evidence);
      // The failed run becomes a new bounded investigation, with its own identified logs.
      // The parent context is given a fresh evidence ID because IDs are globally unique.
      const prior: RunAgentEvidence = { id: `ev_prior_${randomUUID()}`, sourceType: 'tool_result',
        excerpt: sanitizeTerminalText(`Previous diagnosis: ${diagnosis.summary}\nVerification reason: ${proposal.reason}`).slice(0, 4000) };
      await context.investigate(result, [prior]);
      return { status: 'verification_failure', exitCode, output };
    }
    return { status: 'verification_success', exitCode, output };
  } catch (error) {
    const message = claimed ? 'The approved command could not complete or be re-investigated. Review its saved run before retrying.'
      : error instanceof Error ? sanitizeTerminalText(error.message, [context.projectRoot]) : 'The command could not be approved.';
    if (claimed) database.prepare(`UPDATE command_proposals SET status = 'failed', error_summary = ?, updated_at = ? WHERE id = ? AND status IN ('approved', 'failed')`)
      .run(message, new Date().toISOString(), proposalId);
    else database.prepare(`UPDATE command_proposals SET status = 'rejected', error_summary = ?, decision_at = ?, updated_at = ?
      WHERE id = ? AND status = 'proposed' AND investigation_id IN (SELECT id FROM investigations WHERE project_id = ?)`)
      .run(message, new Date().toISOString(), new Date().toISOString(), proposalId, projectId);
    return { status: 'command_failed', proposalId, error: message };
  }
}
