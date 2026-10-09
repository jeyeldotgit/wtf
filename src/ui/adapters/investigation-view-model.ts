import {
  DiagnosisSchema,
  RunAgentEvidenceSchema,
  type Diagnosis,
  type RunAgentEvidence,
} from "../../agents/schemas.js";
import type { InvestigationRecord } from "../../storage/repositories/investigations.js";
import type { RunRecord } from "../../storage/repositories/runs.js";
import { sanitizeTerminalText, sanitizeDiffText } from '../../shared/terminal-text.js';
import type { ReviewProposals } from '../../storage/repositories/review-proposals.js';
export { sanitizeTerminalText } from '../../shared/terminal-text.js';

export type RunSummary = Pick<RunRecord,
  "id" | "commandDisplay" | "exitCode" | "status" | "startTime" | "stdoutBytes" | "stderrBytes"
>;

export type InvestigationViewModel = {
  run: RunSummary;
  investigationId: string;
  status: InvestigationRecord["status"];
  diagnosis: Diagnosis | null;
  evidence: RunAgentEvidence[];
  errorSummary: string | null;
  proposals: ReviewProposals;
};

export function buildRunSummary(run: RunRecord): RunSummary {
  return {
    id: run.id,
    commandDisplay: sanitizeTerminalText(run.commandDisplay, [run.cwd]),
    exitCode: run.exitCode,
    status: run.status,
    startTime: run.startTime,
    stdoutBytes: run.stdoutBytes,
    stderrBytes: run.stderrBytes,
  };
}

export function buildInvestigationViewModel(
  run: RunRecord,
  investigation: InvestigationRecord,
  rawEvidence: unknown[],
  proposals: ReviewProposals = {},
): InvestigationViewModel {
  if (run.id !== investigation.triggerRunId || run.projectId !== investigation.projectId) {
    throw new Error("Investigation and run records do not match");
  }
  const evidence = rawEvidence.map((raw) => {
    const item = RunAgentEvidenceSchema.parse(raw);
    return { ...item, id: sanitizeTerminalText(item.id), excerpt: sanitizeTerminalText(item.excerpt, [run.cwd]) };
  });
  const diagnosis = investigation.diagnosis && investigation.status !== 'failed'
    ? sanitizeDiagnosis(DiagnosisSchema.parse(JSON.parse(investigation.diagnosis)), [run.cwd])
    : null;
  if (diagnosis) validateEvidenceReferences(diagnosis, evidence);

  return {
    run: buildRunSummary(run),
    investigationId: investigation.id,
    status: diagnosis?.missingInformation.length ? 'needs_input' : investigation.status,
    diagnosis,
    evidence,
    proposals: diagnosis && !diagnosis.missingInformation.length && ['diagnosed', 'awaiting_patch_approval'].includes(investigation.status) ? proposals : {},
    errorSummary: investigation.lastErrorSummary === null
      ? null
      : sanitizeTerminalText(investigation.lastErrorSummary, [run.cwd]),
  };
}

function sanitizeDiagnosis(diagnosis: Diagnosis, roots: string[]): Diagnosis {
  const safe = (value: string) => sanitizeTerminalText(value, roots);
  return {
    ...diagnosis,
    summary: safe(diagnosis.summary),
    observations: diagnosis.observations.map((item) => ({
      ...item,
      statement: safe(item.statement),
      evidenceIds: item.evidenceIds.map(safe),
    })),
    likelyCause: diagnosis.likelyCause
      ? {
        ...diagnosis.likelyCause,
        cause: safe(diagnosis.likelyCause.cause),
        rationale: safe(diagnosis.likelyCause.rationale),
        evidenceIds: diagnosis.likelyCause.evidenceIds.map(safe),
      }
      : undefined,
    beginnerExplanation: diagnosis.beginnerExplanation.map(safe),
    proposedFix: diagnosis.proposedFix
      ? {
        ...diagnosis.proposedFix,
        summary: safe(diagnosis.proposedFix.summary),
        evidenceIds: diagnosis.proposedFix.evidenceIds.map(safe),
        files: diagnosis.proposedFix.files.map((file) => ({
          ...file,
          path: safe(file.path),
          diff: sanitizeDiffText(file.diff, roots),
        })),
      }
      : undefined,
    verificationCommand: diagnosis.verificationCommand
      ? {
        ...diagnosis.verificationCommand,
        command: safe(diagnosis.verificationCommand.command),
        reason: safe(diagnosis.verificationCommand.reason),
      }
      : undefined,
    missingInformation: diagnosis.missingInformation.map(safe),
  };
}

function validateEvidenceReferences(diagnosis: Diagnosis, evidence: RunAgentEvidence[]): void {
  const ids = new Set(evidence.map((item) => item.id));
  const references = [
    ...diagnosis.observations.flatMap((item) => item.evidenceIds),
    ...(diagnosis.likelyCause?.evidenceIds ?? []),
    ...(diagnosis.proposedFix?.evidenceIds ?? []),
  ];
  if (references.some((id) => !ids.has(id))) throw new Error("Diagnosis cites evidence that is not available for review");
}
