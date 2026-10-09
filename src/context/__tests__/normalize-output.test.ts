import { describe, it, expect } from 'vitest';
import { normalizeOutput } from '../../capture/normalize-output.js';
import { PERSISTENCE_BYTE_LIMIT } from '../../capture/types.js';
import type { CapturedRun } from '../../capture/types.js';

/** Helper to build a minimal CapturedRun for testing. */
function makeRun(overrides: Partial<CapturedRun> = {}): CapturedRun {
  return {
    runId: 'test-run-id',
    commandText: 'test command',
    stdout: '',
    stderr: '',
    exitStatus: 0,
    startTime: Date.now(),
    durationMs: 100,
    localMetadata: { cwd: '/tmp/test', shell: '/bin/bash' },
    truncation: { stdoutTruncated: false, stderrTruncated: false },
    ...overrides,
  };
}

/** Generate a string of approximately `bytes` UTF-8 bytes. */
function generateString(bytes: number): string {
  // Use numbered lines so head/tail can be verified
  const lines: string[] = [];
  let total = 0;
  let lineNum = 0;
  while (total < bytes) {
    const line = `LINE_${lineNum++}: ${'x'.repeat(70)}\n`;
    lines.push(line);
    total += Buffer.byteLength(line, 'utf-8');
  }
  return lines.join('');
}

describe('normalizeOutput', () => {
  it('passes through small streams unchanged', () => {
    const run = makeRun({ stdout: 'hello\n', stderr: 'world\n' });
    const result = normalizeOutput(run);

    expect(result.stdout).toBe('hello\n');
    expect(result.stderr).toBe('world\n');
    expect(result.truncation.stdoutTruncated).toBe(false);
    expect(result.truncation.stderrTruncated).toBe(false);
  });

  it('does not modify streams under the byte limit', () => {
    const run = makeRun({
      stdout: 'a'.repeat(100),
      stderr: 'b'.repeat(100),
    });
    const result = normalizeOutput(run);
    expect(result.stdout).toBe('a'.repeat(100));
    expect(result.stderr).toBe('b'.repeat(100));
    expect(result.truncation.stdoutTruncated).toBe(false);
    expect(result.truncation.stderrTruncated).toBe(false);
  });

  it('truncates stdout-heavy output while preserving stderr', () => {
    const bigStdout = generateString(5 * 1024 * 1024); // ~5 MB
    const smallStderr = 'Error: something failed\n';
    const run = makeRun({ stdout: bigStdout, stderr: smallStderr });

    const result = normalizeOutput(run);

    // stderr should be fully retained
    expect(result.stderr).toBe(smallStderr);
    expect(result.truncation.stderrTruncated).toBe(false);

    // stdout should be truncated
    expect(result.truncation.stdoutTruncated).toBe(true);
    const stdoutBytes = Buffer.byteLength(result.stdout, 'utf-8');
    expect(stdoutBytes).toBeLessThanOrEqual(PERSISTENCE_BYTE_LIMIT);

    // Truncation marker should be present
    expect(result.stdout).toContain('[... TRUNCATED stdout:');
  });

  it('truncates balanced overflow (both streams large)', () => {
    const bigStdout = generateString(3 * 1024 * 1024); // ~3 MB
    const bigStderr = generateString(3 * 1024 * 1024); // ~3 MB
    const run = makeRun({ stdout: bigStdout, stderr: bigStderr });

    const result = normalizeOutput(run);

    expect(result.truncation.stdoutTruncated).toBe(true);
    expect(result.truncation.stderrTruncated).toBe(true);

    const totalBytes =
      Buffer.byteLength(result.stdout, 'utf-8') +
      Buffer.byteLength(result.stderr, 'utf-8');

    // Total (excluding markers) should be approximately within the limit
    // Markers add a small amount of overhead
    expect(result.stdout).toContain('[... TRUNCATED stdout:');
    expect(result.stderr).toContain('[... TRUNCATED stderr:');
  });

  it('includes accurate byte counts in truncation markers', () => {
    const bigStdout = generateString(3 * 1024 * 1024);
    const run = makeRun({ stdout: bigStdout, stderr: '' });
    const result = normalizeOutput(run);

    const markerMatch = result.stdout.match(
      /\[... TRUNCATED stdout: retained (\d+) of (\d+) bytes ...\]/,
    );
    expect(markerMatch).not.toBeNull();
    if (markerMatch) {
      const retained = parseInt(markerMatch[1], 10);
      const total = parseInt(markerMatch[2], 10);
      expect(retained).toBeLessThan(total);
      expect(total).toBe(Buffer.byteLength(bigStdout, 'utf-8'));
    }
  });

  it('preserves head and tail lines after truncation', () => {
    const bigStdout = generateString(3 * 1024 * 1024);
    const run = makeRun({ stdout: bigStdout, stderr: '' });
    const result = normalizeOutput(run);

    // First line (head) should be present
    expect(result.stdout).toContain('LINE_0:');
    // A late line (tail) should be present
    expect(result.stdout).toMatch(/LINE_\d{3,}:/);
  });

  it('handles empty streams without adding markers', () => {
    const run = makeRun({ stdout: '', stderr: '' });
    const result = normalizeOutput(run);

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.truncation.stdoutTruncated).toBe(false);
    expect(result.truncation.stderrTruncated).toBe(false);
  });

  it('strips null bytes and normalizes line endings', () => {
    const run = makeRun({
      stdout: 'hello\0world\r\n',
      stderr: 'err\0or\r\n',
    });
    const result = normalizeOutput(run);

    expect(result.stdout).toBe('helloworld\n');
    expect(result.stderr).toBe('error\n');
  });
});

