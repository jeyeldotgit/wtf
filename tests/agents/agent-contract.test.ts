import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAgentTools } from "../../src/agents/tools.js";
import {
  DiagnosisSchema,
  GetRecentLogsInputSchema,
  RunAgentInputSchema,
  isSafeProjectRelativePath,
  validateDiagnosisForInput,
} from "../../src/agents/schemas.js";

const validInput = {
  runId: "run-1",
  commandDisplay: "pnpm test",
  exitCode: 1,
  stdout: "",
  stderr: "AssertionError: expected true",
  evidence: [{ id: "ev-1", sourceType: "run_log" as const, excerpt: "AssertionError: expected true" }],
};

describe("run agent contract", () => {
  it("accepts a failed run and rejects a successful run", () => {
    assert.equal(RunAgentInputSchema.safeParse(validInput).success, true);
    assert.equal(RunAgentInputSchema.safeParse({ ...validInput, exitCode: 0 }).success, false);
  });

  it("rejects unbounded absolute, traversal, secret, dependency, and generated paths", () => {
    assert.equal(isSafeProjectRelativePath("src/app.ts"), true);
    for (const path of [
      "/tmp/source.ts",
      "../outside.ts",
      "C:\\private\\file.ts",
      ".env",
      "config/.env.local",
      ".git/config",
      "node_modules/pkg/index.js",
      "dist/app.js",
      "pnpm-lock.yaml",
      "keys/server.pem",
      ".aws/credentials",
      "certs/client.p12",
      ".npmrc",
      "keys/id_ed25519",
    ]) {
      assert.equal(isSafeProjectRelativePath(path), false, path);
    }
  });

  it("limits read-only tool request arguments", () => {
    assert.equal(GetRecentLogsInputSchema.safeParse({ runId: "run-1", limit: 20 }).success, true);
    assert.equal(GetRecentLogsInputSchema.safeParse({ runId: "run-1", limit: 21 }).success, false);
  });

  it("requires diagnosis claims to reference supplied evidence", () => {
    const diagnosis = DiagnosisSchema.parse({
      summary: "The test assertion failed.",
      observations: [{ statement: "The assertion expected true.", evidenceIds: ["ev-missing"] }],
      beginnerExplanation: ["An assertion compares the expected value with the actual value."],
      missingInformation: [],
    });
    assert.throws(() => validateDiagnosisForInput(diagnosis, validInput), /evidence/);
    assert.doesNotThrow(() => validateDiagnosisForInput({
      ...diagnosis,
      observations: [{ statement: "The assertion failed.", evidenceIds: ["ev-1"] }],
    }, validInput));
  });

  it("does not allow a fix proposal when the agent is asking for more information", () => {
    assert.throws(() => validateDiagnosisForInput({
      summary: "The error needs more context.",
      observations: [{ statement: "The command exited with an error.", evidenceIds: ["ev-1"] }],
      beginnerExplanation: ["The captured message does not identify the cause."],
      proposedFix: {
        summary: "Change the configuration.",
        evidenceIds: ["ev-1"],
        files: [{ path: "src/config.ts", diff: "--- a/src/config.ts\n+++ b/src/config.ts\n@@\n-old\n+new" }],
      },
      missingInformation: ["What configuration file is this command using?"],
    }, validInput), /cannot propose a fix/);
  });

  it("defines tool descriptions and schemas without execute handlers", () => {
    for (const definition of Object.values(runAgentTools)) {
      assert.equal(typeof definition.description, "string");
      assert.equal(definition.execute, undefined);
    }
  });
});
