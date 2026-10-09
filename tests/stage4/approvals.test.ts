import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../src/storage/database.js';
import { createCompletedRun, getRun } from '../../src/storage/repositories/runs.js';
import { getReviewProposals, getFixReview, getCommandReview } from '../../src/storage/repositories/review-proposals.js';
import { listEvidence } from '../../src/storage/repositories/evidence.js';
import { getLogEvents } from '../../src/storage/repositories/log-events.js';
import { runInvestigation } from '../../src/investigation/run-investigation.js';
import { applyApprovedPatch } from '../../src/approvals/apply-approved-patch.js';
import { applyUnifiedDiff } from '../../src/approvals/unified-diff.js';
import { RunSession, type RunSessionEvent } from '../../src/session/run-session.js';
import { ManagedShell } from '../../src/capture/managed-shell.js';
import type { Diagnosis, RunAgentInput } from '../../src/agents/schemas.js';
import { buildInvestigationViewModel } from '../../src/ui/adapters/investigation-view-model.js';

const projectId = 'stage4';
const diff = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
const makeDiagnosis = (input: RunAgentInput): Diagnosis => ({
  summary: 'A configuration value is incorrect.',
  observations: [{ statement: 'The command failed.', evidenceIds: [input.evidence[0].id] }],
  likelyCause: { cause: 'Incorrect configuration.', rationale: 'The output identifies a configuration error.', confidence: 'medium', evidenceIds: [input.evidence[0].id] },
  beginnerExplanation: ['Update the configuration, then review the verification command.'],
  proposedFix: { summary: 'Update the value.', evidenceIds: [input.evidence[0].id], files: [{ path: 'config.ts', diff: diff('config.ts') }] },
  verificationCommand: { command: "printf 'verified\\n'", reason: 'Check the corrected configuration.' },
  missingInformation: [],
});

async function setup(change: (diagnosis: Diagnosis) => Diagnosis = diagnosis => diagnosis) {
  const database = openDatabase(':memory:');
  const projectRoot = mkdtempSync(join(tmpdir(), 'wtf-stage4-'));
  writeFileSync(join(projectRoot, 'config.ts'), 'old\n');
  const run = createCompletedRun(database, { projectId, cwd: projectRoot, commandDisplay: 'false', exitCode: 1, stderr: 'Configuration error\n' });
  const agent = async (input: RunAgentInput) => ({ kind: 'diagnosis', diagnosis: change(makeDiagnosis(input)) });
  const investigation = await runInvestigation(run.id, { database, projectId, projectRoot, runAgent: agent });
  assert.notEqual(investigation.status, 'failed');
  const proposals = getReviewProposals(database, projectId, investigation.id);
  return { database, projectRoot, run, investigation, proposals,
    context: { database, projectId, projectRoot, approvalHash: proposals.patch?.hash ?? '' },
    close() { database.close(); rmSync(projectRoot, { recursive: true, force: true }); },
  };
}

describe('Stage 4 approval services', () => {
  it('persists snapshots and changes files only after Apply, without running verification', async () => {
    const fixture = await setup();
    try {
      const patch = fixture.proposals.patch!;
      assert.equal(readFileSync(join(fixture.projectRoot, 'config.ts'), 'utf8'), 'old\n');
      assert.equal(patch.snapshots.length, 1);
      const result = await applyApprovedPatch(patch.id, fixture.context);
      assert.equal(result.status, 'patch_applied');
      assert.equal(readFileSync(join(fixture.projectRoot, 'config.ts'), 'utf8'), 'new\n');
      assert.equal(getFixReview(fixture.database, projectId, patch.id)?.status, 'applied');
      assert.equal(getCommandReview(fixture.database, projectId, fixture.proposals.command!.id)?.status, 'proposed');
      assert.equal((fixture.database.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 1);
      const row = fixture.database.prepare('SELECT decision_at FROM fix_proposals WHERE id = ?').get(patch.id) as { decision_at: string };
      assert.ok(row.decision_at);
      assert.equal((await applyApprovedPatch(patch.id, fixture.context)).status, 'patch_failed');
    } finally { fixture.close(); }
  });

  it('rejects disk edits and persists stale_patch without overwriting the user', async () => {
    const fixture = await setup();
    try {
      writeFileSync(join(fixture.projectRoot, 'config.ts'), 'user edit\n');
      const result = await applyApprovedPatch(fixture.proposals.patch!.id, fixture.context);
      assert.equal(result.status, 'stale_patch');
      assert.equal(readFileSync(join(fixture.projectRoot, 'config.ts'), 'utf8'), 'user edit\n');
      assert.equal(getFixReview(fixture.database, projectId, fixture.proposals.patch!.id)?.status, 'stale');
    } finally { fixture.close(); }
  });

  it('rejects changed proposal contents, invalid tokens and cross-project approvals', async () => {
    for (const mutation of ['contents', 'token', 'project']) {
      const fixture = await setup();
      try {
        if (mutation === 'contents') fixture.database.prepare("UPDATE fix_proposals SET summary = 'changed' WHERE id = ?").run(fixture.proposals.patch!.id);
        const result = await applyApprovedPatch(fixture.proposals.patch!.id, { ...fixture.context,
          approvalHash: mutation === 'token' ? 'incorrect' : fixture.context.approvalHash, projectId: mutation === 'project' ? 'other' : projectId });
        assert.ok(['stale_patch', 'patch_failed'].includes(result.status));
        assert.equal(readFileSync(join(fixture.projectRoot, 'config.ts'), 'utf8'), 'old\n');
      } finally { fixture.close(); }
    }
  });

  it('requires a new preview and approval after a stale patch', async () => {
    const fixture = await setup();
    const session = new RunSession({ database: fixture.database, projectId, projectRoot: fixture.projectRoot,
      runAgent: async input => ({ kind: 'diagnosis', diagnosis: {
        ...makeDiagnosis(input), proposedFix: { ...makeDiagnosis(input).proposedFix!, files: [{ path: 'config.ts', diff: diff('config.ts').replace('-old', '-user edit') }] },
      } }) });
    try {
      const oldPatch = fixture.proposals.patch!;
      writeFileSync(join(fixture.projectRoot, 'config.ts'), 'user edit\n');
      assert.equal((await session.applyPatch(oldPatch.id, oldPatch.hash)).status, 'stale_patch');
      await session.refreshDiagnosis(fixture.investigation.id);
      const fresh = getReviewProposals(fixture.database, projectId, fixture.investigation.id).patch!;
      assert.notEqual(fresh.id, oldPatch.id);
      assert.notEqual(fresh.hash, oldPatch.hash);
      assert.equal(readFileSync(join(fixture.projectRoot, 'config.ts'), 'utf8'), 'user edit\n');
      assert.equal((await session.applyPatch(oldPatch.id, oldPatch.hash)).status, 'patch_failed');
      assert.equal((await session.applyPatch(fresh.id, fresh.hash)).status, 'patch_applied');
      assert.equal(readFileSync(join(fixture.projectRoot, 'config.ts'), 'utf8'), 'new\n');
    } finally { await session.close(); fixture.close(); }
  });

  it('rejects secrets, redacted placeholders and invisible terminal controls in patch contents', async () => {
    for (const text of ['API_KEY=sk-abcdefghijklmnop1234567890', '[REDACTED_SECRET]', '\u001b[2Jhidden']) {
      const fixture = await setup(diagnosis => ({ ...diagnosis, proposedFix: { ...diagnosis.proposedFix!, files: [{ path: 'config.ts', diff: diff('config.ts').replace('+new', `+${text}`) }] } }));
      try {
        assert.equal((await applyApprovedPatch(fixture.proposals.patch!.id, fixture.context)).status, 'patch_failed');
        assert.equal(readFileSync(join(fixture.projectRoot, 'config.ts'), 'utf8'), 'old\n');
      } finally { fixture.close(); }
    }
  });

  it('validates all three files before writing any file', async () => {
    const fixture = await setup(diagnosis => ({ ...diagnosis, proposedFix: { ...diagnosis.proposedFix!, files: [
      { path: 'config.ts', diff: diff('config.ts') },
      { path: 'second.ts', diff: '--- /dev/null\n+++ b/second.ts\n@@ -0,0 +1 @@\n+created\n' },
      { path: 'third.ts', diff: '--- /dev/null\n+++ b/third.ts\n@@ -0,0 +2 @@\n+wrong count\n' },
    ] } }));
    try {
      assert.equal((await applyApprovedPatch(fixture.proposals.patch!.id, fixture.context)).status, 'patch_failed');
      assert.equal(readFileSync(join(fixture.projectRoot, 'config.ts'), 'utf8'), 'old\n');
      assert.equal(existsSync(join(fixture.projectRoot, 'second.ts')), false);
    } finally { fixture.close(); }
  });

  it('applies a three-file change, creation and deletion as one review', async () => {
    const fixture = await setup(diagnosis => ({ ...diagnosis, proposedFix: { ...diagnosis.proposedFix!, files: [
      { path: 'config.ts', diff: diff('config.ts') },
      { path: 'created.ts', diff: '--- /dev/null\n+++ b/created.ts\n@@ -0,0 +1 @@\n+created\n' },
      { path: 'removed.ts', diff: '--- a/removed.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n' },
    ] } }));
    try {
      // Regenerate a preview after establishing the third target.
      writeFileSync(join(fixture.projectRoot, 'removed.ts'), 'old\n');
      const session = new RunSession({ database: fixture.database, projectId, projectRoot: fixture.projectRoot,
        runAgent: async input => ({ kind: 'diagnosis', diagnosis: { ...makeDiagnosis(input), proposedFix: JSON.parse(fixture.investigation.diagnosis!).proposedFix } }) });
      await session.refreshDiagnosis(fixture.investigation.id);
      const patch = getReviewProposals(fixture.database, projectId, fixture.investigation.id).patch!;
      assert.equal((await session.applyPatch(patch.id, patch.hash)).status, 'patch_applied');
      assert.equal(readFileSync(join(fixture.projectRoot, 'config.ts'), 'utf8'), 'new\n');
      assert.equal(readFileSync(join(fixture.projectRoot, 'created.ts'), 'utf8'), 'created\n');
      assert.equal(existsSync(join(fixture.projectRoot, 'removed.ts')), false);
      await session.close();
    } finally { fixture.close(); }
  });

  it('blocks symlink replacement and hard-link targets', async () => {
    const fixture = await setup();
    const outside = mkdtempSync(join(tmpdir(), 'wtf-outside-'));
    try {
      const src = join(fixture.projectRoot, 'config.ts');
      const external = join(outside, 'external.ts');
      writeFileSync(external, 'old\n');
      rmSync(src);
      linkSync(external, src);
      assert.equal((await applyApprovedPatch(fixture.proposals.patch!.id, fixture.context)).status, 'patch_failed');
      assert.equal(readFileSync(external, 'utf8'), 'old\n');
    } finally { fixture.close(); rmSync(outside, { recursive: true, force: true }); }
  });

  it('blocks a parent directory replaced by a junction outside the project', async () => {
    const fixture = await setup();
    const outside = mkdtempSync(join(tmpdir(), 'wtf-junction-outside-'));
    try {
      mkdirSync(join(fixture.projectRoot, 'src'));
      writeFileSync(join(outside, 'config.ts'), 'old\n');
      rmSync(join(fixture.projectRoot, 'src'), { recursive: true });
      symlinkSync(outside, join(fixture.projectRoot, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
      const { readTarget } = await import('../../src/approvals/files.js');
      assert.throws(() => readTarget(fixture.projectRoot, 'src/config.ts'), /Symlinks/);
      assert.equal(readFileSync(join(outside, 'config.ts'), 'utf8'), 'old\n');
    } finally { fixture.close(); rmSync(outside, { recursive: true, force: true }); }
  });

  it('creates no approval proposals in question mode and resumes with redacted answer evidence', async () => {
    const fixture = await setup(diagnosis => ({ ...diagnosis, proposedFix: undefined, missingInformation: ['Which value did you expect?'] }));
    const session = new RunSession({ database: fixture.database, projectId, projectRoot: fixture.projectRoot,
      runAgent: async input => {
        assert.ok(input.evidence.some(item => item.excerpt.includes('User answer:')));
        assert.doesNotMatch(JSON.stringify(input), /my-private-token/);
        return { kind: 'diagnosis', diagnosis: makeDiagnosis(input) };
      } });
    try {
      assert.deepEqual(fixture.proposals, { patch: undefined, command: undefined });
      await session.refreshDiagnosis(fixture.investigation.id, 'token=my-private-token');
      assert.ok(getReviewProposals(fixture.database, projectId, fixture.investigation.id).patch);
      assert.ok(listEvidence(fixture.database, fixture.investigation.id).some(item => item.excerpt.includes('[REDACTED_SECRET]')));
    } finally { await session.close(); fixture.close(); }
  });

  it('runs verification only on a separate Run action and prevents replay', async () => {
    const fixture = await setup();
    const session = new RunSession({ database: fixture.database, projectId, projectRoot: fixture.projectRoot });
    try {
      const patch = fixture.proposals.patch!;
      const command = fixture.proposals.command!;
      assert.equal((await session.applyPatch(patch.id, patch.hash)).status, 'patch_applied');
      assert.equal((fixture.database.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 1);
      const result = await session.runCommand(command.id, command.hash);
      assert.equal(result.status, 'verification_success');
      assert.ok('output' in result && result.output.includes('verified'));
      assert.equal(getCommandReview(fixture.database, projectId, command.id)?.status, 'executed');
      assert.equal((await session.runCommand(command.id, command.hash)).status, 'command_failed');
    } finally { await session.close(); fixture.close(); }
  });

  it('rejects command tampering, secret commands and stale post-patch targets before launch', async () => {
    for (const mode of ['tamper', 'secret', 'stale']) {
      const fixture = await setup(diagnosis => ({ ...diagnosis, verificationCommand: mode === 'secret' ? { command: 'echo token=private-value', reason: 'Check' } : diagnosis.verificationCommand }));
      const session = new RunSession({ database: fixture.database, projectId, projectRoot: fixture.projectRoot });
      try {
        const command = fixture.proposals.command!;
        if (mode === 'tamper') fixture.database.prepare("UPDATE command_proposals SET command = 'echo changed' WHERE id = ?").run(command.id);
        if (mode === 'stale') {
          await session.applyPatch(fixture.proposals.patch!.id, fixture.proposals.patch!.hash);
          writeFileSync(join(fixture.projectRoot, 'config.ts'), 'new user change\n');
        }
        const result = await session.runCommand(command.id, command.hash);
        assert.equal(result.status, mode === 'stale' ? 'stale_patch' : 'command_failed');
        assert.equal((fixture.database.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 1);
      } finally { await session.close(); fixture.close(); }
    }
  });

  it('persists failed verification stdout, stderr and status and re-enters Stage 3 with identified evidence', async () => {
    const fixture = await setup(diagnosis => ({ ...diagnosis, verificationCommand: { command: "printf 'verification out\\n'; printf 'verification err\\n' >&2; false", reason: 'Verify both streams.' } }));
    const events: RunSessionEvent[] = [];
    let agentCalls = 0;
    const session = new RunSession({ database: fixture.database, projectId, projectRoot: fixture.projectRoot,
      runAgent: async input => {
        agentCalls++;
        assert.equal(input.exitCode, 1);
        assert.ok(input.evidence.some(item => item.sourceType === 'run_log' && item.excerpt.includes('verification')));
        assert.ok(input.evidence.some(item => item.excerpt.includes('Previous diagnosis:')));
        return { kind: 'diagnosis', diagnosis: { ...makeDiagnosis(input), proposedFix: undefined, verificationCommand: undefined } };
      } });
    session.subscribe(event => events.push(event));
    try {
      const command = fixture.proposals.command!;
      const result = await session.runCommand(command.id, command.hash);
      assert.equal(result.status, 'verification_failure');
      assert.equal(agentCalls, 1);
      const record = fixture.database.prepare('SELECT run_id FROM command_proposals WHERE id = ?').get(command.id) as { run_id: string };
      assert.equal(getRun(fixture.database, projectId, record.run_id)?.exitCode, 1);
      const logs = getLogEvents(fixture.database, projectId, record.run_id, 20);
      assert.ok(logs.some(item => item.stream === 'stdout' && item.content.includes('verification out')));
      assert.ok(logs.some(item => item.stream === 'stderr' && item.content.includes('verification err')));
      assert.ok(listEvidence(fixture.database, fixture.investigation.id).some(item => item.sourceType === 'run_log' && item.excerpt.includes('Exit status: 1')));
      assert.ok(events.some(event => event.type === 'investigation_completed' && event.investigation.triggerRunId === record.run_id));
    } finally { await session.close(); fixture.close(); }
  });

  it('declines patches and skips commands without filesystem or process side effects', async () => {
    const fixture = await setup();
    const session = new RunSession({ database: fixture.database, projectId, projectRoot: fixture.projectRoot });
    try {
      const patch = fixture.proposals.patch!;
      const command = fixture.proposals.command!;
      session.decline('patch', patch.id, patch.hash);
      session.decline('command', command.id, command.hash);
      assert.equal((await session.applyPatch(patch.id, patch.hash)).status, 'patch_failed');
      assert.equal((await session.runCommand(command.id, command.hash)).status, 'command_failed');
      assert.equal(readFileSync(join(fixture.projectRoot, 'config.ts'), 'utf8'), 'old\n');
      assert.equal((fixture.database.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 1);
    } finally { await session.close(); fixture.close(); }
  });

  it('bounds shell output and execution time while retaining failure capture', async () => {
    const fixture = await setup();
    const shell = new ManagedShell({ cwd: fixture.projectRoot, onOutput: () => {} });
    try {
      const timeout = await shell.execute('sleep 5', { timeoutMs: 100 });
      assert.equal(timeout.exitStatus, 124);
      assert.ok(timeout.durationMs < 3000);
      const large = await shell.execute("printf '%100000s' | tr ' ' x", { timeoutMs: 2000, maxOutputBytes: 1000 });
      assert.equal(large.exitStatus, 124);
      assert.ok(Buffer.byteLength(large.stdout) + Buffer.byteLength(large.stderr) <= 1000);
    } finally { await shell.close(); fixture.close(); }
  });

  it('keeps run cwd out of the view model and redacts credentials and absolute paths in diagnoses', async () => {
    const fixture = await setup(diagnosis => ({ ...diagnosis, summary: '\u001b[31mError\u001b[0m in C:\\private\\project\\app.ts token=private-value' }));
    try {
      const view = buildInvestigationViewModel(fixture.run, fixture.investigation, listEvidence(fixture.database, fixture.investigation.id), fixture.proposals);
      assert.equal('cwd' in view.run, false);
      assert.doesNotMatch(view.diagnosis!.summary, /\u001b|private-value|C:\\/);
    } finally { fixture.close(); }
  });
});

describe('exact diff application', () => {
  it('preserves CRLF and missing final newlines and validates multi-hunk coordinates', () => {
    assert.equal(applyUnifiedDiff('old\r\n', diff('config.ts'), 'config.ts'), 'new\r\n');
    assert.equal(applyUnifiedDiff('old', '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n', 'a.ts'), 'new');
    assert.equal(applyUnifiedDiff('a\nb\nc\n', '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+A\n@@ -3 +3 @@\n-c\n+C\n', 'a.ts'), 'A\nb\nC\n');
    assert.throws(() => applyUnifiedDiff('old\n', diff('other.ts'), 'config.ts'), /headers/);
    assert.throws(() => applyUnifiedDiff('different\n', diff('config.ts'), 'config.ts'), /context/);
  });
});
