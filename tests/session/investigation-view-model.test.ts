import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Diagnosis } from "../../src/agents/schemas.js";
import { buildInvestigationViewModel } from "../../src/ui/adapters/investigation-view-model.js";
import type { InvestigationRecord } from "../../src/storage/repositories/investigations.js";
import type { RunRecord } from "../../src/storage/repositories/runs.js";

const run: RunRecord = {
  id: "view-run",
  projectId: "view-project",
  investigationId: "view-investigation",
  commandDisplay: "pnpm test",
  cwd: "/tmp/private-project",
  startTime: "2026-10-10T00:00:00.000Z",
  endTime: "2026-10-10T00:00:01.000Z",
  exitCode: 1,
  signal: null,
  status: "failed",
  stdoutBytes: 0,
  stderrBytes: 22,
};

function investigation(
  diagnosis: Diagnosis | null,
  status: InvestigationRecord["status"] = "diagnosed",
  lastErrorSummary: string | null = null,
): InvestigationRecord {
  return {
    id: "view-investigation",
    projectId: "view-project",
    triggerRunId: "view-run",
    status,
    diagnosis: diagnosis ? JSON.stringify(diagnosis) : null,
    modelVersion: "test-model",
    promptVersion: "test-prompt",
    lastErrorCode: null,
    lastErrorSummary,
    toolRoundCount: 1,
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:01.000Z",
  };
}

function diagnosis(evidenceId: string): Diagnosis {
  return {
    summary: "\u001b[31mA failure\u001b[0m",
    observations: [{ statement: "\u001b[32mTypeError\u001b[0m", evidenceIds: [evidenceId] }],
    beginnerExplanation: ["Check the value before using it."],
    missingInformation: [],
  };
}

describe("investigation view model", () => {
  it("maps stored diagnosis and evidence to safe display data", () => {
    const model = buildInvestigationViewModel(run, investigation(diagnosis("ev_run")), [
      { id: "ev_run", sourceType: "run_log", excerpt: "\u001b[31mTypeError\u001b[0m" },
    ]);
    assert.equal(model.diagnosis?.summary, "A failure");
    assert.equal(model.evidence[0].excerpt, "TypeError");
    assert.equal("cwd" in model.run, false);
    assert.equal(model.run.commandDisplay, "pnpm test");
  });

  it("rejects a persisted diagnosis whose citations are missing", () => {
    assert.throws(() => buildInvestigationViewModel(run, investigation(diagnosis("ev_missing")), []), /not available for review/);
  });

  it("preserves a question-only diagnosis without a fix", () => {
    const question: Diagnosis = {
      ...diagnosis("ev_run"),
      missingInformation: ["Which input value did you expect?"],
    };
    const model = buildInvestigationViewModel(run, investigation(question, "needs_input"), [
      { id: "ev_run", sourceType: "run_log", excerpt: "TypeError" },
    ]);
    assert.equal(model.status, "needs_input");
    assert.equal(model.diagnosis?.missingInformation[0], "Which input value did you expect?");
    assert.equal(model.diagnosis?.proposedFix, undefined);
  });

  it("preserves every file in a multi-file proposal for read-only rendering", () => {
    const proposal: Diagnosis = {
      ...diagnosis("ev_run"),
      proposedFix: {
        summary: "Update both related files.",
        evidenceIds: ["ev_run", "ev_project"],
        files: [
          { path: "src/app.ts", diff: "--- a/src/app.ts\\n+++ b/src/app.ts\\n@@\\n-old\\n+new" },
          { path: "src/config.ts", diff: "--- a/src/config.ts\\n+++ b/src/config.ts\\n@@\\n-old\\n+new" },
        ],
      },
      missingInformation: [],
    };
    const model = buildInvestigationViewModel(run, investigation(proposal, "awaiting_patch_approval"), [
      { id: "ev_run", sourceType: "run_log", excerpt: "TypeError" },
      { id: "ev_project", sourceType: "project_file", relativePath: "src/app.ts", excerpt: "const value = undefined" },
    ]);
    assert.equal(model.status, "awaiting_patch_approval");
    assert.deepEqual(model.diagnosis?.proposedFix?.files.map((file) => file.path), ["src/app.ts", "src/config.ts"]);
  });

  it("surfaces a safe failure summary when no diagnosis was saved", () => {
    const model = buildInvestigationViewModel(run, investigation(null, "failed", "The local model could not be reached."), [
      { id: "ev_run", sourceType: "run_log", excerpt: "TypeError" },
    ]);
    assert.equal(model.status, "failed");
    assert.equal(model.diagnosis, null);
    assert.equal(model.errorSummary, "The local model could not be reached.");
  });
});
