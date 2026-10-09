import {
  DiagnosisSchema,
  RunAgentEvidenceSchema,
  type Diagnosis,
  type RunAgentEvidence,
} from "../../agents/schemas.js";
import type { InvestigationRecord } from "../../storage/repositories/investigations.js";
import type { RunRecord } from "../../storage/repositories/runs.js";

export type RunSummary = Pick<RunRecord,
  "id" | "commandDisplay" | "exitCode" | "status" | "startTime" | "stdoutBytes" | "stderrBytes"
>;

export type InvestigationViewModel = {
  run: RunSummary;
  status: InvestigationRecord["status"];
  diagnosis: Diagnosis | null;
  evidence: RunAgentEvidence[];
  errorSummary: string | null;
};

export function buildRunSummary(run: RunRecord): RunSummary {
  return {
    id: run.id,
    commandDisplay: sanitizeTerminalText(run.commandDisplay),
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
): InvestigationViewModel {
  if (run.id !== investigation.triggerRunId || run.projectId !== investigation.projectId) {
    throw new Error("Investigation and run records do not match");
  }
  const evidence = rawEvidence.map((raw) => {
    const item = RunAgentEvidenceSchema.parse(raw);
    return { ...item, excerpt: sanitizeTerminalText(item.excerpt) };
  });
  const diagnosis = investigation.diagnosis
    ? sanitizeDiagnosis(DiagnosisSchema.parse(JSON.parse(investigation.diagnosis)))
    : null;
  if (diagnosis) validateEvidenceReferences(diagnosis, evidence);

  return {
    run: buildRunSummary(run),
    status: investigation.status,
    diagnosis,
    evidence,
    errorSummary: investigation.lastErrorSummary === null
      ? null
      : sanitizeTerminalText(investigation.lastErrorSummary),
  };
}

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r\n?/g, "\n");
}

function sanitizeDiagnosis(diagnosis: Diagnosis): Diagnosis {
  return {
    ...diagnosis,
    summary: sanitizeTerminalText(diagnosis.summary),
    observations: diagnosis.observations.map((item) => ({
      ...item,
      statement: sanitizeTerminalText(item.statement),
    })),
    likelyCause: diagnosis.likelyCause
      ? {
        ...diagnosis.likelyCause,
        cause: sanitizeTerminalText(diagnosis.likelyCause.cause),
        rationale: sanitizeTerminalText(diagnosis.likelyCause.rationale),
      }
      : undefined,
    beginnerExplanation: diagnosis.beginnerExplanation.map(sanitizeTerminalText),
    proposedFix: diagnosis.proposedFix
      ? {
        ...diagnosis.proposedFix,
        summary: sanitizeTerminalText(diagnosis.proposedFix.summary),
        files: diagnosis.proposedFix.files.map((file) => ({
          ...file,
          path: sanitizeTerminalText(file.path),
          diff: sanitizeTerminalText(file.diff),
        })),
      }
      : undefined,
    verificationCommand: diagnosis.verificationCommand
      ? {
        ...diagnosis.verificationCommand,
        command: sanitizeTerminalText(diagnosis.verificationCommand.command),
        reason: sanitizeTerminalText(diagnosis.verificationCommand.reason),
      }
      : undefined,
    missingInformation: diagnosis.missingInformation.map(sanitizeTerminalText),
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
