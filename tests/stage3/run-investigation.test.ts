import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentRunError } from "../../src/agents/run-agent.js";
import {
  RunAgentInputSchema,
  RunAgentResultSchema,
  type RunAgentEvidence,
  type RunAgentInput,
} from "../../src/agents/schemas.js";
import {
  appendToolEvidence,
  capInitialRunAgentInput,
  runAgentInputCharacters,
  TOOL_EVIDENCE_CHAR_LIMIT,
  TOOL_ROUND_EXCERPT_CHAR_LIMIT,
} from "../../src/context/append-tool-evidence.js";
import {
  dispatchToolRequest,
  type DispatchContext,
  type DispatchOptions,
  type DispatchResult,
} from "../../src/investigation/tool-dispatcher.js";
import { runInvestigation } from "../../src/investigation/run-investigation.js";
import { createInvestigation, getInvestigationByTriggerRun } from "../../src/storage/repositories/investigations.js";
import { getToolCalls } from "../../src/storage/repositories/tool-calls.js";
import { listEvidence } from "../../src/storage/repositories/evidence.js";
import { createCompletedRun } from "../../src/storage/repositories/runs.js";
import { openDatabase } from "../../src/storage/database.js";
import { migrateDatabase } from "../../src/storage/schema.js";

const PROJECT_ID = "stage3-project";
const RUN_ID = "stage3-failed-run";

type TestSetup = ReturnType<typeof setup>;

function setup() {
  const database = openDatabase(":memory:");
  const projectRoot = mkdtempSync(join(tmpdir(), "wtf-stage3-"));
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "config.ts"), "export const mode = 'safe';\n");
  const run = createCompletedRun(database, {
    id: RUN_ID,
    projectId: PROJECT_ID,
    commandDisplay: "pnpm test",
    cwd: projectRoot,
    exitCode: 1,
    stderr: "TypeError: cannot read property value\n",
  });
  return {
    database,
    projectRoot,
    run,
    close() {
      database.close();
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

function dependencies(setup: TestSetup, overrides: Partial<Parameters<typeof runInvestigation>[1]> = {}) {
  return {
    database: setup.database,
    projectId: PROJECT_ID,
    projectRoot: setup.projectRoot,
    ...overrides,
  };
}

function diagnosis(input: RunAgentInput, evidenceIds = [input.evidence[0].id]) {
  return {
    kind: "diagnosis",
    diagnosis: {
      summary: "The command failed because a value was unavailable.",
      observations: [{ statement: "The captured run contains the failure.", evidenceIds }],
      beginnerExplanation: ["The program tried to use a value that was not available."],
      missingInformation: [],
    },
  };
}

function request(toolName: string, input: unknown) {
  return { kind: "tool_requests", requests: [{ toolName, input }] };
}

function toolEvidence(input: RunAgentInput): RunAgentEvidence[] {
  return input.evidence.filter((item) => item.id.startsWith("ev_"));
}

function countingDispatcher(counter: { count: number }) {
  return async (rawRequest: unknown, context: DispatchContext, options?: DispatchOptions): Promise<DispatchResult> => {
    counter.count += 1;
    return dispatchToolRequest(rawRequest, context, options);
  };
}

function baseInput(): RunAgentInput {
  return RunAgentInputSchema.parse({
    runId: "large-run",
    commandDisplay: "pnpm test",
    exitCode: 1,
    stdout: "",
    stderr: "initial failure",
    evidence: [{ id: "run_log_stderr_large-run", sourceType: "run_log", excerpt: "initial failure" }],
  });
}

describe("bounded investigation loop", () => {
  it("persists a direct diagnosis without requesting tools", async () => {
    const context = setup();
    const calls: boolean[] = [];
    try {
      const result = await runInvestigation(RUN_ID, dependencies(context, {
        runAgent: async (input, options) => {
          calls.push(options.allowTools === true);
          return diagnosis(input);
        },
      }));
      assert.equal(result.status, "diagnosed");
      assert.equal(result.toolRoundCount, 0);
      assert.deepEqual(calls, [true]);
      assert.equal(listEvidence(context.database, result.id)[0].id, "run_log_stderr_stage3-failed-run");
      assert.deepEqual(getToolCalls(context.database, result.id), []);
    } finally {
      context.close();
    }
  });

  it("resolves the project and database from the stored run when dependencies are omitted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wtf-stage3-default-"));
    const databasePath = join(directory, "history.sqlite");
    const projectRoot = join(directory, "project");
    mkdirSync(projectRoot, { recursive: true });
    const originalDatabasePath = process.env.WTF_DATABASE_PATH;
    process.env.WTF_DATABASE_PATH = databasePath;
    try {
      const database = openDatabase(databasePath);
      createCompletedRun(database, {
        id: "default-context-run",
        projectId: "default-project",
        commandDisplay: "pnpm test",
        cwd: projectRoot,
        exitCode: 1,
        stderr: "TypeError: failed\\n",
      });
      database.close();
      const result = await runInvestigation("default-context-run", {
        runAgent: async (input) => diagnosis(input),
      });
      assert.equal(result.status, "diagnosed");
      assert.equal(result.projectId, "default-project");
    } finally {
      if (originalDatabasePath === undefined) delete process.env.WTF_DATABASE_PATH;
      else process.env.WTF_DATABASE_PATH = originalDatabasePath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists a fix diagnosis as awaiting patch approval", async () => {
    const context = setup();
    try {
      const result = await runInvestigation(RUN_ID, dependencies(context, {
        runAgent: async (input) => ({
          kind: "diagnosis",
          diagnosis: {
            summary: "The failure is caused by an unchecked value.",
            observations: [{ statement: "The run reports a TypeError.", evidenceIds: [input.evidence[0].id] }],
            beginnerExplanation: ["The code needs to check that the value exists before using it."],
            proposedFix: {
              summary: "Guard the value before reading it.",
              evidenceIds: [input.evidence[0].id],
              files: [{ path: "src/config.ts", diff: "--- a/src/config.ts\\n+++ b/src/config.ts\\n@@\\n-old\\n+new" }],
            },
            missingInformation: [],
          },
        }),
      }));
      assert.equal(result.status, "awaiting_patch_approval");
      assert.ok(JSON.parse(result.diagnosis ?? "{}").proposedFix);
    } finally {
      context.close();
    }
  });

  it("does not create an investigation for a successful run", async () => {
    const context = setup();
    try {
      createCompletedRun(context.database, {
        id: "successful-stage3-run",
        projectId: PROJECT_ID,
        commandDisplay: "pnpm test",
        cwd: context.projectRoot,
        exitCode: 0,
        stdout: "All tests passed.\\n",
      });
      await assert.rejects(() => runInvestigation("successful-stage3-run", dependencies(context)));
      assert.equal(getInvestigationByTriggerRun(context.database, PROJECT_ID, "successful-stage3-run"), undefined);
    } finally {
      context.close();
    }
  });

  it("executes one lookup and grounds the next diagnosis in its evidence", async () => {
    const context = setup();
    const calls: RunAgentInput[] = [];
    const dispatches = { count: 0 };
    try {
      const result = await runInvestigation(RUN_ID, dependencies(context, {
        dispatchToolRequest: countingDispatcher(dispatches),
        runAgent: async (input) => {
          calls.push(input);
          if (calls.length === 1) return request("getRecentLogs", { runId: RUN_ID, limit: 5 });
          const evidence = toolEvidence(input);
          assert.ok(evidence.length > 0);
          return diagnosis(input, [evidence[0].id]);
        },
      }));
      assert.equal(result.status, "diagnosed", `${result.lastErrorCode}: ${result.lastErrorSummary}`);
      assert.equal(result.toolRoundCount, 1);
      assert.equal(dispatches.count, 1);
      assert.ok(calls[1].evidence.some((item) => item.id === calls[0].evidence[0].id));
      assert.equal(getToolCalls(context.database, result.id)[0].outcomeStatus, "ok");
    } finally {
      context.close();
    }
  });

  it("retains evidence from sequential log and project lookups", async () => {
    const context = setup();
    const calls: RunAgentInput[] = [];
    const dispatches = { count: 0 };
    try {
      const result = await runInvestigation(RUN_ID, dependencies(context, {
        dispatchToolRequest: countingDispatcher(dispatches),
        runAgent: async (input) => {
          calls.push(input);
          if (calls.length === 1) return request("searchLogs", { query: "TypeError", limit: 5 });
          if (calls.length === 2) return request("getProjectContext", { query: "config.ts", maxFiles: 3 });
          const evidence = toolEvidence(input);
          assert.ok(evidence.some((item) => item.sourceType === "historical_log" || item.sourceType === "run_log"));
          assert.ok(evidence.some((item) => item.sourceType === "project_file"));
          return diagnosis(input, evidence.slice(0, 3).map((item) => item.id));
        },
      }));
      assert.equal(result.status, "diagnosed");
      assert.equal(result.toolRoundCount, 2);
      assert.equal(dispatches.count, 2);
      assert.ok(calls[2].evidence.length > calls[0].evidence.length);
      assert.equal(getToolCalls(context.database, result.id).length, 2);
    } finally {
      context.close();
    }
  });

  it("halts at one focused question and does not attach a fix", async () => {
    const context = setup();
    try {
      const result = await runInvestigation(RUN_ID, dependencies(context, {
        runAgent: async () => ({
          kind: "diagnosis",
          diagnosis: {
            summary: "The captured error needs one more detail.",
            observations: [{ statement: "The run failed without identifying the input value.", evidenceIds: ["run_log_stderr_stage3-failed-run"] }],
            beginnerExplanation: ["A value is missing from the captured evidence."],
            missingInformation: ["Which value did you expect this command to receive?"],
          },
        }),
      }));
      assert.equal(result.status, "needs_input");
      assert.equal(result.toolRoundCount, 0);
      const persisted = JSON.parse(result.diagnosis ?? "{}") as { missingInformation?: string[]; proposedFix?: unknown };
      assert.equal(persisted.missingInformation?.length, 1);
      assert.equal(persisted.proposedFix, undefined);
    } finally {
      context.close();
    }
  });

  it("deduplicates a completed request and uses one tools-disabled fallback", async () => {
    const context = setup();
    const flags: boolean[] = [];
    const dispatches = { count: 0 };
    try {
      const result = await runInvestigation(RUN_ID, dependencies(context, {
        dispatchToolRequest: countingDispatcher(dispatches),
        runAgent: async (input, options) => {
          flags.push(options.allowTools === true);
          if (flags.length <= 2) return request("searchLogs", { query: "TypeError", limit: 5 });
          return diagnosis(input, [toolEvidence(input)[0].id]);
        },
      }));
      assert.equal(result.status, "diagnosed");
      assert.deepEqual(flags, [true, true, false]);
      assert.equal(dispatches.count, 1);
      assert.equal(getToolCalls(context.database, result.id).length, 1);
    } finally {
      context.close();
    }
  });

  it("executes at most three requests and makes the fourth call with tools disabled", async () => {
    const context = setup();
    const flags: boolean[] = [];
    const dispatches = { count: 0 };
    const requests = [
      request("getRecentLogs", { runId: RUN_ID, limit: 5 }),
      request("searchLogs", { query: "TypeError", limit: 5 }),
      request("getProjectContext", { query: "config.ts", maxFiles: 3 }),
    ];
    try {
      const result = await runInvestigation(RUN_ID, dependencies(context, {
        dispatchToolRequest: countingDispatcher(dispatches),
        runAgent: async (input, options) => {
          flags.push(options.allowTools === true);
          if (flags.length <= 3) return requests[flags.length - 1];
          return diagnosis(input, toolEvidence(input).slice(0, 3).map((item) => item.id));
        },
      }));
      assert.equal(result.status, "diagnosed");
      assert.deepEqual(flags, [true, true, true, false]);
      assert.equal(dispatches.count, 3);
      assert.equal(result.toolRoundCount, 3);
    } finally {
      context.close();
    }
  });

  it("truncates initial and per-round evidence within the reserved character budgets", () => {
    const initial = RunAgentInputSchema.parse({
      ...baseInput(),
      stdout: "o".repeat(16_000),
      stderr: "e".repeat(16_000),
      evidence: [{ id: "run_log_stderr_large-run", sourceType: "run_log", excerpt: "i".repeat(4_000) }],
    });
    const capped = capInitialRunAgentInput(initial);
    assert.ok(runAgentInputCharacters(capped) <= 32_000);

    const result = appendToolEvidence(capped, Array.from({ length: 6 }, (_, index) => ({
      id: `ev_budget_${index}`,
      sourceType: "historical_log" as const,
      excerpt: String(index).repeat(4_000),
    })));
    const addedCharacters = result.appendedEvidence.reduce((sum, item) => sum + item.excerpt.length, 0);
    const toolCharacters = result.input.evidence
      .filter((item) => item.id.startsWith("ev_") || item.sourceType !== "run_log")
      .reduce((sum, item) => sum + item.excerpt.length, 0);
    assert.equal(result.limited, true);
    assert.ok(addedCharacters <= TOOL_ROUND_EXCERPT_CHAR_LIMIT);
    assert.ok(toolCharacters <= TOOL_EVIDENCE_CHAR_LIMIT);
    assert.ok(result.input.evidence.some((item) => item.sourceType === "tool_result" && item.excerpt.includes("truncated/limited")));
    assert.doesNotThrow(() => RunAgentInputSchema.parse(result.input));
  });

  it("retains a limitation note in the outcome evidence when compacting a response", () => {
    const result = appendToolEvidence(baseInput(), [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `ev_outcome_${index}`,
        sourceType: "historical_log" as const,
        excerpt: "x".repeat(4_000),
      })),
      { id: "ev_outcome_result", sourceType: "tool_result", excerpt: "More matches were omitted." },
    ]);
    const outcome = result.appendedEvidence.find((item) => item.sourceType === "tool_result");
    assert.equal(result.limited, true);
    assert.ok(outcome?.excerpt.includes("truncated/limited"));
    assert.ok(result.appendedEvidence.reduce((sum, item) => sum + item.excerpt.length, 0) <= TOOL_ROUND_EXCERPT_CHAR_LIMIT);
  });

  it("enforces the cumulative tool-evidence and total-input caps", () => {
    const initial = RunAgentInputSchema.parse({
      ...baseInput(),
      stdout: "o".repeat(14_000),
      stderr: "e".repeat(14_000),
      evidence: [
        { id: "run_log_stderr_large-run", sourceType: "run_log", excerpt: "i".repeat(4_000) },
        ...Array.from({ length: 3 }, (_, index) => ({
          id: `ev_prior_${index}`,
          sourceType: "historical_log" as const,
          excerpt: "p".repeat(4_000),
        })),
      ],
    });
    const result = appendToolEvidence(initial, Array.from({ length: 3 }, (_, index) => ({
      id: `ev_cumulative_${index}`,
      sourceType: "historical_log" as const,
      excerpt: "c".repeat(4_000),
    })));
    const toolCharacters = result.input.evidence
      .filter((item) => item.id.startsWith("ev_") || item.sourceType !== "run_log")
      .reduce((sum, item) => sum + item.excerpt.length, 0);
    assert.equal(result.limited, true);
    assert.ok(runAgentInputCharacters(result.input) <= 48_000);
    assert.ok(toolCharacters <= TOOL_EVIDENCE_CHAR_LIMIT);
    assert.ok(result.input.evidence.some((item) => item.sourceType === "tool_result" && item.excerpt.includes("truncated/limited")));
    assert.equal(result.budgetExhausted, true);
  });

  it("reserves an evidence slot for a limitation note at the 18-tool-item limit", () => {
    const initial = RunAgentInputSchema.parse({
      ...baseInput(),
      evidence: [
        { id: "run_log_stderr_large-run", sourceType: "run_log", excerpt: "initial failure" },
        ...Array.from({ length: 17 }, (_, index) => ({
          id: `ev_existing_${index}`,
          sourceType: "historical_log" as const,
          excerpt: "previous evidence",
        })),
      ],
    });
    const result = appendToolEvidence(initial, [
      { id: "ev_new_high", sourceType: "historical_log", excerpt: "high-ranked result" },
      { id: "ev_new_low", sourceType: "historical_log", excerpt: "lower-ranked result" },
    ]);
    const toolItems = result.input.evidence.filter((item) => item.id.startsWith("ev_") || item.sourceType !== "run_log");
    assert.equal(toolItems.length, 18);
    assert.ok(toolItems.some((item) => item.sourceType === "tool_result" && item.excerpt.includes("truncated/limited")));
    assert.ok(result.input.evidence.some((item) => item.id === "ev_existing_0"));
    assert.equal(result.budgetExhausted, true);
  });

  it("rejects multi-tool results and falls back without executing either request", async () => {
    const context = setup();
    const flags: boolean[] = [];
    const dispatches = { count: 0 };
    const twoRequests = {
      kind: "tool_requests",
      requests: [
        { toolName: "searchLogs", input: { query: "TypeError", limit: 5 } },
        { toolName: "getProjectContext", input: { query: "config.ts", maxFiles: 3 } },
      ],
    };
    assert.equal(RunAgentResultSchema.safeParse(twoRequests).success, false);
    try {
      const result = await runInvestigation(RUN_ID, dependencies(context, {
        dispatchToolRequest: countingDispatcher(dispatches),
        runAgent: async (input, options) => {
          flags.push(options.allowTools === true);
          return flags.length === 1 ? twoRequests : diagnosis(input);
        },
      }));
      assert.equal(result.status, "diagnosed");
      assert.deepEqual(flags, [true, false]);
      assert.equal(dispatches.count, 0);
      assert.deepEqual(getToolCalls(context.database, result.id), []);
    } finally {
      context.close();
    }
  });

  it("resumes after a completed lookup and reuses persisted evidence", async () => {
    const context = setup();
    const dispatches = { count: 0 };
    try {
      const first = await runInvestigation(RUN_ID, dependencies(context, {
        dispatchToolRequest: countingDispatcher(dispatches),
        runAgent: async (_input, options) => {
          if (options.allowTools) return request("getRecentLogs", { runId: RUN_ID, limit: 5 });
          throw new AgentRunError("offline", "connection");
        },
      }));
      assert.equal(first.status, "failed");
      assert.equal(first.toolRoundCount, 1);

      const resumed = await runInvestigation(RUN_ID, dependencies(context, {
        dispatchToolRequest: countingDispatcher(dispatches),
        runAgent: async (input) => {
          const evidence = toolEvidence(input);
          assert.ok(evidence.length > 0);
          return diagnosis(input, [evidence[0].id]);
        },
      }));
      assert.equal(resumed.status, "diagnosed");
      assert.equal(resumed.toolRoundCount, 1);
      assert.equal(dispatches.count, 1);
      assert.equal(getToolCalls(context.database, resumed.id).length, 1);
    } finally {
      context.close();
    }
  });

  it("retries a pending read-only lookup after restart and completes the same ledger row", async () => {
    const context = setup();
    try {
      const first = await runInvestigation(RUN_ID, dependencies(context, {
        runAgent: async () => request("searchLogs", { query: "TypeError", limit: 5 }),
        dispatchToolRequest: async () => {
          throw new Error("simulated process failure");
        },
      }));
      assert.equal(first.status, "failed");
      const beforeRestart = getToolCalls(context.database, first.id);
      assert.equal(beforeRestart.length, 1);
      assert.equal(beforeRestart[0].outcomeStatus, "pending");

      const second = await runInvestigation(RUN_ID, dependencies(context, {
        runAgent: async (input) => {
          const evidence = toolEvidence(input);
          assert.ok(evidence.length > 0);
          return diagnosis(input, [evidence[0].id]);
        },
      }));
      const afterRestart = getToolCalls(context.database, second.id);
      assert.equal(second.status, "diagnosed");
      assert.equal(afterRestart.length, 1);
      assert.equal(afterRestart[0].outcomeStatus, "ok");
      assert.equal(second.toolRoundCount, 1);
    } finally {
      context.close();
    }
  });

  it("upgrades an existing Stage 2 database while preserving its records", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    try {
      migrateDatabase(database, 1);
      database.prepare(`
        INSERT INTO runs (id, project_id, command_display, cwd, start_time, end_time, exit_code, status, stderr_bytes)
        VALUES ('legacy-run', 'legacy-project', 'pnpm test', '/tmp/legacy-project', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', 1, 'failed', 14)
      `).run();
      database.prepare(`
        INSERT INTO log_events (run_id, stream, sequence, content, created_at)
        VALUES ('legacy-run', 'stderr', 0, 'legacy failure', '2026-01-01T00:00:01.000Z')
      `).run();
      const legacyRun = { id: "legacy-run", projectId: "legacy-project" };
      const legacyInvestigation = createInvestigation(database, {
        id: "legacy-investigation",
        projectId: legacyRun.projectId,
        triggerRunId: legacyRun.id,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      database.prepare(`
        INSERT INTO investigation_tool_calls
          (id, investigation_id, round, tool_name, request_hash, outcome_status, safe_summary, created_at)
        VALUES ('legacy-call', 'legacy-investigation', 1, 'searchLogs', 'legacy-hash', 'ok', 'searched', '2026-01-01T00:00:00.000Z')
      `).run();
      assert.equal(legacyInvestigation, "legacy-investigation");

      migrateDatabase(database);
      const version = database.prepare("PRAGMA user_version").get() as { user_version: number };
      const investigation = database.prepare("SELECT status, last_error_code, tool_round_count FROM investigations WHERE id = 'legacy-investigation'").get() as Record<string, string | number | null>;
      const call = database.prepare("SELECT request_json, outcome_status FROM investigation_tool_calls WHERE id = 'legacy-call'").get() as Record<string, string>;
      assert.equal(version.user_version, 3);
      assert.equal(investigation.status, "investigating");
      assert.equal(investigation.last_error_code, null);
      assert.equal(investigation.tool_round_count, 0);
      assert.equal(call.request_json, "{}");
      assert.equal(call.outcome_status, "ok");
      assert.equal(database.prepare("SELECT investigation_id FROM runs WHERE id = 'legacy-run'").get()?.investigation_id, "legacy-investigation");
      assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally {
      database.close();
    }
  });
});
