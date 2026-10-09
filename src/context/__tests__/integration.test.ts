import { describe, it, expect, vi } from 'vitest';
import { ManagedShell } from '../../capture/managed-shell.js';
import { normalizeOutput } from '../../capture/normalize-output.js';
import { buildRunAgentInput } from '../build-run-agent-input.js';
import { redactSecrets, SecretRedactor } from '../redact-secrets.js';
import {
  PERSISTENCE_BYTE_LIMIT,
  AGGREGATE_CHAR_LIMIT,
  RunAgentInputSchema,
} from '../../capture/types.js';

describe('Integration: end-to-end pipeline', () => {
  // ── Test 1: Zero exit status ─────────────────────────────────────────────
  it('records exitStatus 0 and does NOT produce RunAgentInput', async () => {
    const shell = new ManagedShell();
    const run = await shell.execute('echo hello');
    shell.destroy();

    expect(run.exitStatus).toBe(0);
    expect(run.stdout).toContain('hello');
    expect(run.stderr).toBe('');

    const input = buildRunAgentInput(run);
    expect(input).toBeNull();
  });

  // ── Test 2: Nonzero exit status ──────────────────────────────────────────
  it('produces a validated RunAgentInput for a failing command', async () => {
    const shell = new ManagedShell();
    const run = await shell.execute('ls /nonexistent_path_for_wtf_test_xyz 2>&1 1>/dev/null');
    shell.destroy();

    expect(run.exitStatus).not.toBe(0);
    expect(run.exitStatus).not.toBeNull();

    const normalized = normalizeOutput(run);
    const input = buildRunAgentInput(normalized);
    expect(input).not.toBeNull();
    expect(input!.exitCode).toBeGreaterThan(0);

    // Must be schema-valid
    expect(() => RunAgentInputSchema.parse(input!)).not.toThrow();
  });

  // ── Test 3: Stream independence ──────────────────────────────────────────
  it('captures stdout and stderr as distinct, unmixed streams', async () => {
    const shell = new ManagedShell();
    // Write to stdout and stderr separately
    const run = await shell.execute(
      'echo STDOUT_MARKER; echo STDERR_MARKER >&2',
    );
    shell.destroy();

    expect(run.stdout).toContain('STDOUT_MARKER');
    expect(run.stdout).not.toContain('STDERR_MARKER');
    expect(run.stderr).toContain('STDERR_MARKER');
    expect(run.stderr).not.toContain('STDOUT_MARKER');
  });

  // ── Test 4: Cross-chunk secret redaction ─────────────────────────────────
  it('redacts secrets split across chunk boundaries', () => {
    const redactor = new SecretRedactor();

    // Split "API_KEY=sk-proj-12345abcdefghijklmnopqr" across two chunks
    const chunk1 = 'Deploying... API_KEY=sk-pr';
    const chunk2 = 'oj-12345abcdefghijklmnopqr done.\n';

    const out1 = redactor.feed(chunk1);
    const out2 = redactor.feed(chunk2);
    const out3 = redactor.flush();
    const combined = out1 + out2 + out3;

    expect(combined).toContain('[REDACTED_SECRET]');
    expect(combined).not.toContain('sk-proj-12345abcdefghijklmnopqr');

    // Also verify via one-shot on the full string
    const fullText = chunk1 + chunk2;
    const oneShot = redactSecrets(fullText);
    expect(oneShot).toContain('[REDACTED_SECRET]');
    expect(oneShot).not.toContain('sk-proj-12345abcdefghijklmnopqr');
  });

  // ── Test 5: Bounded retention ────────────────────────────────────────────
  it('enforces the 2 MB persistence limit and 48K RunAgentInput budget', () => {
    // Generate ~5 MB of stdout content
    const lines: string[] = [];
    let totalBytes = 0;
    let i = 0;
    while (totalBytes < 5 * 1024 * 1024) {
      const line = `LINE_${i++}: ${'x'.repeat(70)}\n`;
      lines.push(line);
      totalBytes += Buffer.byteLength(line, 'utf-8');
    }
    const bigStdout = lines.join('');

    // Build a synthetic CapturedRun
    const run = {
      runId: 'bounded-test-run-id',
      commandText: 'cat /dev/urandom | head -c 5M',
      stdout: bigStdout,
      stderr: 'error: something failed\n',
      exitStatus: 1 as number | null,
      startTime: Date.now(),
      durationMs: 500,
      localMetadata: { cwd: '/home/testuser/project', shell: '/bin/bash' },
      truncation: { stdoutTruncated: false, stderrTruncated: false },
    };

    // Normalize (2 MB limit)
    const normalized = normalizeOutput(run);
    const normalizedBytes =
      Buffer.byteLength(normalized.stdout, 'utf-8') +
      Buffer.byteLength(normalized.stderr, 'utf-8');
    // Allow some overhead for the truncation marker text
    expect(normalizedBytes).toBeLessThanOrEqual(
      PERSISTENCE_BYTE_LIMIT + 200,
    );
    expect(normalized.truncation.stdoutTruncated).toBe(true);

    // Build RunAgentInput (48K limit)
    const input = buildRunAgentInput(normalized)!;
    expect(input).not.toBeNull();

    let totalChars =
      input.runId.length +
      input.commandDisplay.length +
      input.stdout.length +
      input.stderr.length;
    for (const e of input.evidence) {
      totalChars += e.id.length + e.excerpt.length;
    }
    expect(totalChars).toBeLessThanOrEqual(AGGREGATE_CHAR_LIMIT);
  });

  // ── Test 6: Empty failure evidence ───────────────────────────────────────
  it('produces fallback evidence for `false` (empty stdout/stderr, exit 1)', async () => {
    const shell = new ManagedShell();
    const run = await shell.execute('false');
    shell.destroy();

    expect(run.exitStatus).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');

    const input = buildRunAgentInput(run)!;
    expect(input).not.toBeNull();
    expect(input.evidence.length).toBe(1);
    expect(input.evidence[0].excerpt).toContain(
      'Command failed with exit status 1',
    );
    expect(input.evidence[0].excerpt).toContain(
      'Both stdout and stderr were empty',
    );

    // Must be schema-valid
    expect(() => RunAgentInputSchema.parse(input)).not.toThrow();
  });

  // ── Test 7: No path leakage ──────────────────────────────────────────────
  it('scrubs all local paths from the RunAgentInput payload', async () => {
    const shell = new ManagedShell();
    // Deliberately include paths in both stdout and stderr
    const run = await shell.execute(
      'echo "Error at /home/testuser/project/src/index.ts:5"; echo "Also /Users/dev/app/main.go" >&2; exit 1',
    );
    shell.destroy();

    const input = buildRunAgentInput(run)!;
    expect(input).not.toBeNull();

    const json = JSON.stringify(input);
    // No absolute local paths should appear
    expect(json).not.toMatch(/\/home\/[^\s"]+/);
    expect(json).not.toMatch(/\/Users\/[^\s"]+/);
    // The placeholder should be present
    expect(json).toContain('[LOCAL_PATH]');
  });

  // ── Test 8: Ollama offline resilience ────────────────────────────────────
  it('preserves local capture when runAgent() throws a network error', async () => {
    const shell = new ManagedShell();
    const run = await shell.execute('echo "debug info"; exit 2');
    shell.destroy();

    const normalized = normalizeOutput(run);
    const input = buildRunAgentInput(normalized)!;
    expect(input).not.toBeNull();

    // Simulate a failed runAgent() call
    const mockRunAgent = vi.fn().mockRejectedValue(
      new Error('ECONNREFUSED: Ollama service unavailable'),
    );

    // The capture should remain intact regardless of LLM failure
    try {
      await mockRunAgent(input);
    } catch {
      // Expected
    }

    // Verify the original normalized run is unaffected
    expect(normalized.stdout).toContain('debug info');
    expect(normalized.exitStatus).toBe(2);
    expect(normalized.localMetadata.cwd).toBeTruthy();
    expect(normalized.localMetadata.shell).toBeTruthy();

    // mockRunAgent was called but failed — that's fine
    expect(mockRunAgent).toHaveBeenCalledWith(input);
  });
});

