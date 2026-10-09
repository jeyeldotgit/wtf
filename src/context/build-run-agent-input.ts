import {
  RunAgentInputSchema,
  AGGREGATE_CHAR_LIMIT,
  RUN_ID_LIMIT,
  COMMAND_DISPLAY_LIMIT,
  STDOUT_CHAR_LIMIT,
  STDERR_CHAR_LIMIT,
  EVIDENCE_EXCERPT_LIMIT,
  EVIDENCE_ID_LIMIT,
} from '../capture/types.js';
import type { CapturedRun, RunAgentInput, EvidenceItem } from '../capture/types.js';
import { redactSecrets } from './redact-secrets.js';

// ─── Path scrubbing ─────────────────────────────────────────────────────────

/**
 * Remove absolute local filesystem paths from text.
 * Replaces /home/..., /Users/..., /tmp/... paths with a safe placeholder.
 */
function scrubPaths(text: string): string {
  return text.replace(
    /\/(?:home|Users|tmp)\/[^\s:'")\]}>]+/g,
    '[LOCAL_PATH]',
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Truncate a string to at most `limit` characters. */
function truncateChars(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit);
}

/** Generate a deterministic, schema-safe evidence ID. */
function evidenceId(tag: string, runId: string): string {
  const raw = `run_log_${tag}_${runId}`;
  return truncateChars(raw, EVIDENCE_ID_LIMIT);
}

// ─── Main builder ───────────────────────────────────────────────────────────

/**
 * Build a validated RunAgentInput from a CapturedRun.
 *
 * Returns `null` when the command should NOT be forwarded to the agent:
 * - exitStatus === 0  → success, nothing to diagnose.
 * - exitStatus === null → unknown/signal, don't invent a status.
 *
 * For nonzero exits (1–255), constructs a schema-valid payload with:
 * - Secret redaction on all text fields.
 * - Local path scrubbing on all text fields.
 * - Per-field character limits enforced.
 * - Aggregate 48 K character budget enforced.
 * - At least 1 evidence entry (empty-stream fallback).
 */
export function buildRunAgentInput(run: CapturedRun): RunAgentInput | null {
  // ── Gating ──────────────────────────────────────────────────────────────
  if (run.exitStatus === null || run.exitStatus === 0) {
    return null;
  }

  const exitCode = run.exitStatus; // guaranteed 1–255 by gate

  // ── Sanitize text fields ────────────────────────────────────────────────
  const runId = truncateChars(run.runId, RUN_ID_LIMIT);

  const commandDisplay = truncateChars(
    scrubPaths(redactSecrets(run.commandText)),
    COMMAND_DISPLAY_LIMIT,
  );

  let stdout = truncateChars(
    scrubPaths(redactSecrets(run.stdout)),
    STDOUT_CHAR_LIMIT,
  );

  let stderr = truncateChars(
    scrubPaths(redactSecrets(run.stderr)),
    STDERR_CHAR_LIMIT,
  );

  // ── Evidence ────────────────────────────────────────────────────────────
  const evidence: EvidenceItem[] = [];

  if (stdout.length > 0) {
    evidence.push({
      id: evidenceId('stdout', runId),
      type: 'run_log' as const,
      excerpt: truncateChars(stdout, EVIDENCE_EXCERPT_LIMIT),
    });
  }

  if (stderr.length > 0) {
    evidence.push({
      id: evidenceId('stderr', runId),
      type: 'run_log' as const,
      excerpt: truncateChars(stderr, EVIDENCE_EXCERPT_LIMIT),
    });
  }

  // Fallback: both streams empty on a failed command
  if (evidence.length === 0) {
    evidence.push({
      id: evidenceId('empty', runId),
      type: 'run_log' as const,
      excerpt: `Command failed with exit status ${exitCode}. Both stdout and stderr were empty.`,
    });
  }

  // ── Aggregate budget enforcement ────────────────────────────────────────
  const computeTotal = (): number => {
    let total = runId.length + commandDisplay.length + stdout.length + stderr.length;
    for (const e of evidence) {
      total += e.id.length + e.excerpt.length;
    }
    return total;
  };

  let total = computeTotal();

  if (total > AGGREGATE_CHAR_LIMIT) {
    // Trim stdout and stderr proportionally to fit the budget
    const overflow = total - AGGREGATE_CHAR_LIMIT;
    const combinedStreamLen = stdout.length + stderr.length;

    if (combinedStreamLen > 0) {
      const stdoutTrim = Math.ceil(overflow * (stdout.length / combinedStreamLen));
      const stderrTrim = overflow - stdoutTrim;

      stdout = stdout.slice(0, Math.max(0, stdout.length - stdoutTrim));
      stderr = stderr.slice(0, Math.max(0, stderr.length - stderrTrim));

      // Rebuild evidence with trimmed streams
      evidence.length = 0;
      if (stdout.length > 0) {
        evidence.push({
          id: evidenceId('stdout', runId),
          type: 'run_log' as const,
          excerpt: truncateChars(stdout, EVIDENCE_EXCERPT_LIMIT),
        });
      }
      if (stderr.length > 0) {
        evidence.push({
          id: evidenceId('stderr', runId),
          type: 'run_log' as const,
          excerpt: truncateChars(stderr, EVIDENCE_EXCERPT_LIMIT),
        });
      }
      if (evidence.length === 0) {
        evidence.push({
          id: evidenceId('empty', runId),
          type: 'run_log' as const,
          excerpt: `Command failed with exit status ${exitCode}. Both stdout and stderr were empty.`,
        });
      }
    }

    // Final safety check — hard cap
    total = computeTotal();
    if (total > AGGREGATE_CHAR_LIMIT) {
      const remaining = total - AGGREGATE_CHAR_LIMIT;
      stdout = stdout.slice(0, Math.max(0, stdout.length - remaining));
    }
  }

  // ── Construct payload explicitly (no object spread from run) ────────────
  const payload = {
    runId: runId,
    commandDisplay: commandDisplay,
    exitCode: exitCode,
    stdout: stdout,
    stderr: stderr,
    evidence: evidence,
  };

  // Validate with Zod schema — throws ZodError on failure
  return RunAgentInputSchema.parse(payload);
}

