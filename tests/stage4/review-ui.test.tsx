import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { render, renderToString } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Diagnosis } from '../../src/agents/schemas.js';
import { DiffViewer } from '../../src/ui/components/DiffViewer.js';
import { DiagnosisReview } from '../../src/ui/components/DiagnosisReview.js';
import { InvestigationView } from '../../src/ui/views/InvestigationView.js';
import { sanitizeTerminalText } from '../../src/shared/terminal-text.js';
import { RunSession } from '../../src/session/run-session.js';
import { openDatabase } from '../../src/storage/database.js';
import { getReviewProposals } from '../../src/storage/repositories/review-proposals.js';

const files = ['first.ts', 'second.ts', 'third.ts'].map(path => ({ path,
  diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n` }));
const diagnosis: Diagnosis = {
  summary: 'Three files need the same correction.',
  observations: [{ statement: 'The command reported an incorrect value.', evidenceIds: ['ev_run'] }],
  likelyCause: { cause: 'Incorrect value.', rationale: 'The captured error identifies the value.', confidence: 'medium', evidenceIds: ['ev_run'] },
  beginnerExplanation: ['Review the files.', 'Run verification after approving the patch.'],
  proposedFix: { summary: 'Correct the value in three files.', evidenceIds: ['ev_run'], files },
  verificationCommand: { command: "printf verified", reason: 'Check the corrected files.' },
  missingInformation: [],
};

const noop = () => {};
const reviewProps = {
  diagnosis, needsInput: false, disabled: false,
  patchState: { status: 'awaiting_patch_approval' as const, proposalId: 'patch', diffs: files },
  commandState: { status: 'awaiting_command_approval' as const, proposalId: 'command', command: 'printf verified', reason: 'Check' },
  onApply: noop, onDecline: noop, onRun: noop, onSkip: noop, onRefresh: noop, onAnswer: noop,
};

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('The terminal did not reach the expected state.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('Stage 4 terminal review', () => {
  it('renders every relative file heading and exact hunk in a three-file preview', () => {
    const text = sanitizeTerminalText(renderToString(<DiffViewer proposedFix={diagnosis.proposedFix!} />, { columns: 120 }));
    for (const file of files) {
      assert.ok(text.includes(file.path));
      for (const line of file.diff.trimEnd().split('\n')) assert.ok(text.includes(line), `Missing diff line: ${line}`);
    }
    assert.doesNotMatch(text, /diagnosis-only|read-only proposed/i);
  });

  it('hides both approval cards and all diffs in needs_input, even with inconsistent proposal data', () => {
    for (const question of [true, false]) {
      const text = renderToString(<DiagnosisReview {...reviewProps} needsInput={!question}
        diagnosis={{ ...diagnosis, missingInformation: question ? ['Which input did you expect?'] : [] }} />, { columns: 120 });
      assert.doesNotMatch(text, /Approve file changes|Approve verification command|Proposed fix|\[Apply\]|\[Run\]|\[Skip\]|\[Decline\]/);
      if (question) assert.match(text, /Which input did you expect/);
    }
  });

  it('strips ANSI, OSC clipboard payloads, DCS, C1 controls, reports and secrets', () => {
    const hostile = 'safe\u001b[2J\u001b[6n\u001b]52;c;clipboard\u0007\u001bPdevice payload\u001b\\\u009b31mtext\u009d0;title\u009c token="private value" C:\\private\\file.ts';
    const safe = sanitizeTerminalText(hostile);
    assert.doesNotMatch(safe, /\u001b|[\u0080-\u009f]|clipboard|device payload|title|private value|C:\\/);
    assert.match(safe, /safetext/);
    assert.match(safe, /REDACTED_SECRET/);
    assert.equal(sanitizeTerminalText('before\u001b]52;c;unterminated'), 'before');
    assert.equal(sanitizeTerminalText('before\u001b[12;'), 'before');
    const rendered = renderToString(<DiagnosisReview {...reviewProps} diagnosis={{ ...diagnosis, summary: hostile }} />, { columns: 120 });
    assert.doesNotMatch(rendered, /clipboard|device payload|private value|C:\\private/);
  });

  it('requires distinct keyboard actions for Apply and Run and derives results from the real services', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wtf-stage4-ui-'));
    const database = openDatabase(':memory:');
    for (const file of files) writeFileSync(join(root, file.path), 'old\n');
    const session = new RunSession({ database, projectId: 'ui-stage4', projectRoot: root,
      runAgent: async input => ({ kind: 'diagnosis', diagnosis: { ...diagnosis,
        observations: diagnosis.observations.map(item => ({ ...item, evidenceIds: [input.evidence[0].id] })),
        likelyCause: { ...diagnosis.likelyCause!, evidenceIds: [input.evidence[0].id] },
        proposedFix: { ...diagnosis.proposedFix!, evidenceIds: [input.evidence[0].id] },
      } }) });
    const stdin = new PassThrough() as unknown as PassThrough & NodeJS.ReadStream;
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    stdin.ref = () => stdin;
    stdin.unref = () => stdin;
    let output = '';
    const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } }) as NodeJS.WriteStream;
    stdout.columns = 120;
    stdout.rows = 200;
    const originalTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    const app = render(<InvestigationView session={session} />, { stdin, stdout, stderr: stdout, debug: true, patchConsole: false, interactive: false });
    try {
      await app.waitUntilRenderFlush();
      const initial = await session.execute('false');
      assert.ok(initial?.investigation);
      await until(() => output.includes('[Apply]') && output.includes('[Run]'));
      const proposals = getReviewProposals(database, 'ui-stage4', initial.investigation.id);
      assert.equal(readFileSync(join(root, 'first.ts'), 'utf8'), 'old\n');
      await new Promise(resolve => setTimeout(resolve, 40));
      stdin.write('\u001b[B');
      await until(() => output.includes('> [Apply]'));
      stdin.write('\r');
      await until(() => readFileSync(join(root, 'first.ts'), 'utf8') === 'new\n');
      await until(() => output.includes('patch applied'));
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 1);
      const command = database.prepare('SELECT status FROM command_proposals WHERE id = ?').get(proposals.command!.id) as { status: string };
      assert.equal(command.status, 'proposed');
      await new Promise(resolve => setTimeout(resolve, 40));
      stdin.write('\u001b[B');
      await until(() => output.includes('> [Run]'));
      stdin.write('\r');
      await until(() => output.includes('verification success'));
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 2);
      assert.match(output, /verified/);
      assert.doesNotMatch(output, /C:\\Users|wtf-stage4-ui-/);
      const next = await session.execute('false');
      const nextProposals = getReviewProposals(database, 'ui-stage4', next!.investigation!.id);
      await new Promise(resolve => setTimeout(resolve, 60));
      stdin.write('\r'); // The default choice is Decline, with no arrow selection.
      await until(() => (database.prepare('SELECT status FROM fix_proposals WHERE id = ?').get(nextProposals.patch!.id) as { status: string }).status === 'rejected');
      await new Promise(resolve => setTimeout(resolve, 60));
      stdin.write('\r'); // A second explicit action chooses Skip.
      await until(() => (database.prepare('SELECT status FROM command_proposals WHERE id = ?').get(nextProposals.command!.id) as { status: string }).status === 'rejected');
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 3);
    } catch (error) {
      throw new Error(`${(error as Error).message}\nLast terminal frame:\n${sanitizeTerminalText(output).slice(-5000)}`);
    } finally {
      app.unmount();
      await app.waitUntilExit();
      if (originalTTY) Object.defineProperty(process.stdin, 'isTTY', originalTTY);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      await session.close();
      stdin.destroy();
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
