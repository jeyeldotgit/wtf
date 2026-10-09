import { z } from 'zod';

// ─── Persistence & budget constants ─────────────────────────────────────────

/** Maximum combined stdout + stderr bytes stored per command. */
export const PERSISTENCE_BYTE_LIMIT = 2 * 1024 * 1024; // 2 MB

/** Maximum total characters across all RunAgentInput fields. */
export const AGGREGATE_CHAR_LIMIT = 48_000;

/** Per-field character caps for RunAgentInput. */
export const RUN_ID_LIMIT = 100;
export const COMMAND_DISPLAY_LIMIT = 1_000;
export const STDOUT_CHAR_LIMIT = 16_000;
export const STDERR_CHAR_LIMIT = 16_000;

/** Evidence constraints. */
export const EVIDENCE_EXCERPT_LIMIT = 4_000;
export const EVIDENCE_ID_LIMIT = 80;
export const EVIDENCE_MIN_COUNT = 1;
export const EVIDENCE_MAX_COUNT = 30;

// ─── Internal captured-run contract ─────────────────────────────────────────

/**
 * Represents a fully captured command execution.
 * This is the internal storage format — localMetadata MUST NOT leak into
 * RunAgentInput or any external context.
 */
export interface CapturedRun {
  /** UUID v4, generated at command start. */
  runId: string;
  /** Raw command string as entered by the user. */
  commandText: string;
  /** Captured stdout (post-normalization). */
  stdout: string;
  /** Captured stderr (post-normalization). */
  stderr: string;
  /** 0–255, or null when the exit code is unknown (e.g. killed by signal). */
  exitStatus: number | null;
  /** Date.now() at spawn time. */
  startTime: number;
  /** Elapsed milliseconds. */
  durationMs: number;
  /** Local-only metadata — NEVER sent to the model context. */
  localMetadata: {
    cwd: string;
    shell: string;
  };
  /** Whether each stream was truncated to fit the persistence limit. */
  truncation: {
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
}

// ─── RunAgentInput Zod schema ───────────────────────────────────────────────

export const EvidenceItemSchema = z.object({
  id: z.string().max(EVIDENCE_ID_LIMIT),
  type: z.literal('run_log'),
  excerpt: z.string().max(EVIDENCE_EXCERPT_LIMIT),
  relativePath: z.string().optional(),
});

export const RunAgentInputSchema = z.object({
  runId: z.string().max(RUN_ID_LIMIT),
  commandDisplay: z.string().max(COMMAND_DISPLAY_LIMIT),
  exitCode: z.number().int().min(1).max(255),
  stdout: z.string().max(STDOUT_CHAR_LIMIT),
  stderr: z.string().max(STDERR_CHAR_LIMIT),
  evidence: z
    .array(EvidenceItemSchema)
    .min(EVIDENCE_MIN_COUNT)
    .max(EVIDENCE_MAX_COUNT),
});

export type RunAgentInput = z.infer<typeof RunAgentInputSchema>;
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

