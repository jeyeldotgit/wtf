import { describe, it, expect } from 'vitest';
import { buildRunAgentInput } from '../build-run-agent-input.js';
import {
  AGGREGATE_CHAR_LIMIT,
  COMMAND_DISPLAY_LIMIT,
  STDOUT_CHAR_LIMIT,
  STDERR_CHAR_LIMIT,
  RunAgentInputSchema,
} from '../../capture/types.js';
import type { CapturedRun } from '../../capture/types.js';

/** Helper to build a minimal CapturedRun. */
function makeRun(overrides: Partial<CapturedRun> = {}): CapturedRun {
  return {
    runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    commandText: 'test-command',
    stdout: '',
    stderr: '',
    exitStatus: 1,
    startTime: Date.now(),
    durationMs: 50,
    localMetadata: { cwd: '/home/jeyel/Documents/wtf', shell: '/bin/bash' },
    truncation: { stdoutTruncated: false, stderrTruncated: false },
    ...overrides,
  };
}

describe('buildRunAgentInput — gating', () => {
  it('returns null for exit status 0 (success)', () => {
    const run = makeRun({ exitStatus: 0, stdout: 'hello\n' });
    expect(buildRunAgentInput(run)).toBeNull();
  });

  it('returns null for exit status null (unknown/signal)', () => {
    const run = makeRun({ exitStatus: null, stderr: 'Killed\n' });
    expect(buildRunAgentInput(run)).toBeNull();
  });

  it('returns a RunAgentInput for nonzero exit status', () => {
    const run = makeRun({ exitStatus: 1, stderr: 'Error: file not found\n' });
    const result = buildRunAgentInput(run);
    expect(result).not.toBeNull();
    expect(result!.exitCode).toBe(1);
  });
});

describe('buildRunAgentInput — evidence', () => {
  it('generates stdout evidence when stdout is non-empty', () => {
    const run = makeRun({ stdout: 'some output\n', stderr: '' });
    const result = buildRunAgentInput(run)!;
    expect(result.evidence.length).toBeGreaterThanOrEqual(1);
    expect(result.evidence.some((e) => e.id.includes('stdout'))).toBe(true);
  });

  it('generates stderr evidence when stderr is non-empty', () => {
    const run = makeRun({ stdout: '', stderr: 'error message\n' });
    const result = buildRunAgentInput(run)!;
    expect(result.evidence.length).toBeGreaterThanOrEqual(1);
    expect(result.evidence.some((e) => e.id.includes('stderr'))).toBe(true);
  });

  it('generates both stdout and stderr evidence entries', () => {
    const run = makeRun({ stdout: 'out\n', stderr: 'err\n' });
    const result = buildRunAgentInput(run)!;
    expect(result.evidence.length).toBe(2);
  });

  it('generates a fallback evidence entry when both streams are empty', () => {
    const run = makeRun({ exitStatus: 1, stdout: '', stderr: '' });
    const result = buildRunAgentInput(run)!;
    expect(result.evidence.length).toBe(1);
    expect(result.evidence[0].excerpt).toContain(
      'Command failed with exit status 1',
    );
    expect(result.evidence[0].excerpt).toContain(
      'Both stdout and stderr were empty',
    );
    expect(result.evidence[0].id).toContain('empty');
  });

  it('does not include relativePath on run_log evidence', () => {
    const run = makeRun({ stderr: 'error\n' });
    const result = buildRunAgentInput(run)!;
    for (const e of result.evidence) {
      expect(e.relativePath).toBeUndefined();
    }
  });
});

describe('buildRunAgentInput — secret redaction', () => {
  it('redacts API keys in stdout', () => {
    const run = makeRun({
      stdout: 'API_KEY=sk-proj-thisisasecretkeyvalue1234567890\n',
    });
    const result = buildRunAgentInput(run)!;
    expect(result.stdout).toContain('[REDACTED_SECRET]');
    expect(result.stdout).not.toContain('thisisasecretkeyvalue1234567890');
  });

  it('redacts secrets in stderr', () => {
    const run = makeRun({
      stderr: 'Error: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig\n',
    });
    const result = buildRunAgentInput(run)!;
    expect(result.stderr).toContain('[REDACTED_SECRET]');
    expect(result.stderr).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts secrets in commandDisplay', () => {
    const run = makeRun({
      commandText: 'curl -H "Authorization: Bearer eyJhbGci.test.sig" https://api.example.com',
    });
    const result = buildRunAgentInput(run)!;
    expect(result.commandDisplay).toContain('[REDACTED_SECRET]');
    expect(result.commandDisplay).not.toContain('eyJhbGci');
  });

  it('redacts secrets in evidence excerpts', () => {
    const run = makeRun({
      stderr: 'password: "super_secret_value_here"\n',
    });
    const result = buildRunAgentInput(run)!;
    const stderrEvidence = result.evidence.find((e) => e.id.includes('stderr'));
    expect(stderrEvidence).toBeDefined();
    expect(stderrEvidence!.excerpt).toContain('[REDACTED_SECRET]');
    expect(stderrEvidence!.excerpt).not.toContain('super_secret_value_here');
  });
});

describe('buildRunAgentInput — path scrubbing', () => {
  it('removes /home/... paths from stdout', () => {
    const run = makeRun({
      stdout: 'Error at /home/jeyel/Documents/wtf/src/run.ts:14\n',
    });
    const result = buildRunAgentInput(run)!;
    expect(result.stdout).toContain('[LOCAL_PATH]');
    expect(result.stdout).not.toContain('/home/jeyel');
  });

  it('removes /Users/... paths from stderr', () => {
    const run = makeRun({
      stderr: 'Error at /Users/dev/project/index.ts:1\n',
    });
    const result = buildRunAgentInput(run)!;
    expect(result.stderr).toContain('[LOCAL_PATH]');
    expect(result.stderr).not.toContain('/Users/dev');
  });

  it('does not leak cwd from localMetadata', () => {
    const run = makeRun({
      stderr: 'fail\n',
    });
    const result = buildRunAgentInput(run)!;
    const json = JSON.stringify(result);
    expect(json).not.toContain('/home/jeyel');
    expect(json).not.toContain('localMetadata');
    expect(json).not.toContain('"cwd"');
    expect(json).not.toContain('"shell"');
    expect(json).not.toContain('truncation');
  });
});

describe('buildRunAgentInput — field limits', () => {
  it('truncates commandDisplay to the character limit', () => {
    const longCommand = 'x'.repeat(5_000);
    const run = makeRun({ commandText: longCommand, stderr: 'error\n' });
    const result = buildRunAgentInput(run)!;
    expect(result.commandDisplay.length).toBeLessThanOrEqual(COMMAND_DISPLAY_LIMIT);
  });

  it('truncates stdout to the character limit', () => {
    const longStdout = 'y'.repeat(50_000);
    const run = makeRun({ stdout: longStdout });
    const result = buildRunAgentInput(run)!;
    expect(result.stdout.length).toBeLessThanOrEqual(STDOUT_CHAR_LIMIT);
  });

  it('truncates stderr to the character limit', () => {
    const longStderr = 'z'.repeat(50_000);
    const run = makeRun({ stderr: longStderr });
    const result = buildRunAgentInput(run)!;
    expect(result.stderr.length).toBeLessThanOrEqual(STDERR_CHAR_LIMIT);
  });
});

describe('buildRunAgentInput — aggregate budget', () => {
  it('ensures total payload characters stay within the 48K limit', () => {
    const run = makeRun({
      stdout: 'a'.repeat(16_000),
      stderr: 'b'.repeat(16_000),
      commandText: 'c'.repeat(1_000),
    });
    const result = buildRunAgentInput(run)!;

    let total =
      result.runId.length +
      result.commandDisplay.length +
      result.stdout.length +
      result.stderr.length;
    for (const e of result.evidence) {
      total += e.id.length + e.excerpt.length;
    }

    expect(total).toBeLessThanOrEqual(AGGREGATE_CHAR_LIMIT);
  });

  it('trims streams proportionally when aggregate budget is exceeded', () => {
    // Construct a run that will exceed 48K after evidence is added
    const run = makeRun({
      stdout: 'a'.repeat(16_000),
      stderr: 'b'.repeat(16_000),
      commandText: 'c'.repeat(1_000),
    });
    const result = buildRunAgentInput(run)!;

    // The result must still be schema-valid
    expect(() => RunAgentInputSchema.parse(result)).not.toThrow();
  });
});

describe('buildRunAgentInput — schema validation', () => {
  it('returns a value that passes RunAgentInputSchema.parse()', () => {
    const run = makeRun({
      exitStatus: 127,
      stderr: 'command not found\n',
    });
    const result = buildRunAgentInput(run)!;
    expect(() => RunAgentInputSchema.parse(result)).not.toThrow();
  });

  it('has no fields from CapturedRun localMetadata', () => {
    const run = makeRun({
      exitStatus: 2,
      stderr: 'error\n',
    });
    const result = buildRunAgentInput(run)!;
    const keys = Object.keys(result);
    expect(keys).toEqual(
      expect.arrayContaining(['runId', 'commandDisplay', 'exitCode', 'stdout', 'stderr', 'evidence']),
    );
    expect(keys).not.toContain('localMetadata');
    expect(keys).not.toContain('truncation');
    expect(keys).not.toContain('commandText');
    expect(keys).not.toContain('startTime');
    expect(keys).not.toContain('durationMs');
    expect(keys).not.toContain('exitStatus');
  });
});
