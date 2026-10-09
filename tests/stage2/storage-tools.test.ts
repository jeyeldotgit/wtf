import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RunAgentEvidenceSchema } from "../../src/agents/schemas.js";
import { dispatchToolRequest } from "../../src/investigation/tool-dispatcher.js";
import { handleGetProjectContext } from "../../src/investigation/tool-handlers/get-project-context.js";
import { handleGetRecentLogs } from "../../src/investigation/tool-handlers/get-recent-logs.js";
import { handleSearchLogs } from "../../src/investigation/tool-handlers/search-logs.js";
import { openDatabase } from "../../src/storage/database.js";
import { getLogEvents, searchLogEvents } from "../../src/storage/repositories/log-events.js";
import { createInvestigation, transitionInvestigation } from "../../src/storage/repositories/investigations.js";
import { clearHistory, completeRun, createCompletedRun, createRun, purgeExpiredRuns } from "../../src/storage/repositories/runs.js";
import { createCommandProposalPlaceholder } from "../../src/storage/repositories/command-proposals.js";
import { createFixProposalPlaceholder } from "../../src/storage/repositories/fix-proposals.js";
import { listEvidence } from "../../src/storage/repositories/evidence.js";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "wtf-stage2-"));
}

function fixtureRun(database: ReturnType<typeof openDatabase>, input: {
  id: string;
  projectId?: string;
  cwd?: string;
  stdout?: string;
  stderr?: string;
  events?: Array<{ stream: "stdout" | "stderr"; content: string; sequence?: number }>;
  startTime?: string;
}) {
  const projectId = input.projectId ?? "project-a";
  const run = createRun(database, {
    id: input.id,
    projectId,
    commandDisplay: "pnpm test",
    cwd: input.cwd ?? "C:/workspace/project-a",
    startTime: input.startTime,
  });
  completeRun(database, {
    runId: run.id,
    projectId,
    exitCode: 1,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
    events: input.events,
    endTime: input.startTime,
  });
  return run;
}

describe("Stage 2 local storage and bounded tools", () => {
  it("persists runs, logs, investigations, evidence, and proposals after reopening the database", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "history.sqlite");
    try {
      let database = openDatabase(databasePath);
      assert.equal((database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
      assert.equal((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode.toLowerCase(), "wal");
      fixtureRun(database, { id: "persistent-run", stderr: "Assertion failed\n" });
      const investigationId = createInvestigation(database, {
        id: "persistent-investigation",
        projectId: "project-a",
        triggerRunId: "persistent-run",
      });
      database.prepare(`
        INSERT INTO investigation_evidence
          (id, investigation_id, source_type, source_id, excerpt, content_hash, relative_path, created_at)
        VALUES ('persist-evidence', ?, 'tool_result', 'tool', 'lookup complete', 'hash', NULL, '2026-01-01T00:00:00.000Z')
      `).run(investigationId);
      createFixProposalPlaceholder(database, investigationId);
      createCommandProposalPlaceholder(database, investigationId);
      database.close();

      database = openDatabase(databasePath);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = 'persistent-run'").get()?.count, 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM log_events WHERE run_id = 'persistent-run'").get()?.count, 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM investigations WHERE id = 'persistent-investigation'").get()?.count, 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM investigation_evidence WHERE id = 'persist-evidence'").get()?.count, 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM fix_proposals").get()?.count, 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM command_proposals").get()?.count, 1);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("purges expired runs transactionally and cascades linked history while retaining recent projects", () => {
    const database = openDatabase(":memory:");
    try {
      fixtureRun(database, { id: "old-run", startTime: "2025-01-01T00:00:00.000Z", stderr: "old error\n" });
      fixtureRun(database, { id: "new-run", startTime: "2025-01-20T00:00:00.000Z", stderr: "new error\n" });
      const investigationId = createInvestigation(database, { id: "old-investigation", projectId: "project-a", triggerRunId: "old-run" });
      database.prepare(`
        INSERT INTO investigation_evidence
          (id, investigation_id, source_type, source_id, excerpt, content_hash, relative_path, created_at)
        VALUES ('old-evidence', ?, 'tool_result', 'tool', 'old result', 'hash', NULL, '2025-01-01T00:00:00.000Z')
      `).run(investigationId);
      database.prepare(`
        INSERT INTO investigation_tool_calls
          (id, investigation_id, round, tool_name, request_hash, outcome_status, safe_summary, created_at)
        VALUES ('old-call', ?, 0, 'searchLogs', 'hash', 'ok', 'searched', '2025-01-01T00:00:00.000Z')
      `).run(investigationId);
      createFixProposalPlaceholder(database, investigationId);
      createCommandProposalPlaceholder(database, investigationId);

      assert.equal(purgeExpiredRuns(database, new Date("2025-01-20T00:00:00.000Z"), 14), 1);
      for (const table of ["runs", "log_events", "investigations", "investigation_evidence", "investigation_tool_calls", "fix_proposals", "command_proposals"]) {
        assert.equal(Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count), table === "runs" || table === "log_events" ? 1 : 0, table);
      }
    } finally {
      database.close();
    }
  });

  it("rolls back the run and all events if completed-run persistence fails", () => {
    const database = openDatabase(":memory:");
    try {
      assert.throws(() => createCompletedRun(database, {
        id: "bad-sequence-run",
        projectId: "project-a",
        commandDisplay: "pnpm test",
        cwd: "C:/workspace/project-a",
        exitCode: 1,
        events: [
          { stream: "stdout", sequence: 0, content: "first" },
          { stream: "stderr", sequence: 0, content: "duplicate sequence" },
        ],
      }));
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = 'bad-sequence-run'").get()?.count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM log_events WHERE run_id = 'bad-sequence-run'").get()?.count, 0);
    } finally {
      database.close();
    }
  });

  it("runs the 14-day retention cleanup automatically when opening the local database", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "history.sqlite");
    try {
      let database = openDatabase(databasePath);
      fixtureRun(database, { id: "expired-run", startTime: "2000-01-01T00:00:00.000Z", stderr: "old\n" });
      const investigationId = createInvestigation(database, { projectId: "project-a", triggerRunId: "expired-run" });
      database.prepare(`
        INSERT INTO investigation_evidence
          (id, investigation_id, source_type, source_id, excerpt, content_hash, relative_path, created_at)
        VALUES ('expired-evidence', ?, 'tool_result', 'tool', 'old', 'hash', NULL, '2000-01-01T00:00:00.000Z')
      `).run(investigationId);
      database.close();

      database = openDatabase(databasePath);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM runs WHERE id = 'expired-run'").get()?.count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM investigation_evidence WHERE id = 'expired-evidence'").get()?.count, 0);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires explicit confirmation to clear only the selected project's history", () => {
    const database = openDatabase(":memory:");
    try {
      fixtureRun(database, { id: "project-a-run", projectId: "project-a" });
      fixtureRun(database, { id: "project-b-run", projectId: "project-b", cwd: "C:/workspace/project-b" });
      const investigationA = createInvestigation(database, { id: "project-a-investigation", projectId: "project-a", triggerRunId: "project-a-run" });
      assert.throws(() => database.prepare("UPDATE runs SET investigation_id = ? WHERE id = 'project-b-run'").run(investigationA), /project mismatch/);
      assert.throws(() => clearHistory(database, "project-a", false), /confirmation/);
      assert.equal(clearHistory(database, "project-a", true), 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM runs WHERE project_id = 'project-b'").get()?.count, 1);
    } finally {
      database.close();
    }
  });

  it("enforces the investigation state machine and project scope", () => {
    const database = openDatabase(":memory:");
    try {
      fixtureRun(database, { id: "state-run" });
      const investigationId = createInvestigation(database, { projectId: "project-a", triggerRunId: "state-run" });
      assert.throws(() => transitionInvestigation(database, {
        id: investigationId, projectId: "project-b", status: "resolved",
      }), /not found in the active project/);
      transitionInvestigation(database, { id: investigationId, projectId: "project-a", status: "awaiting_user" });
      transitionInvestigation(database, { id: investigationId, projectId: "project-a", status: "resolved" });
      assert.throws(() => transitionInvestigation(database, {
        id: investigationId, projectId: "project-a", status: "investigating",
      }), /Invalid investigation transition/);
    } finally {
      database.close();
    }
  });

  it("stores redacted logs and never returns local absolute paths in evidence", () => {
    const database = openDatabase(":memory:");
    try {
      fixtureRun(database, {
        id: "private-run",
        cwd: "C:/Users/Alice/work/project-a",
        events: [{ stream: "stderr", sequence: 0, content: "token=top-secret C:/Users/Alice/work/project-a/src/app.ts failed\n" }],
      });
      const stored = getLogEvents(database, "project-a", "private-run", 5)[0].content;
      assert.doesNotMatch(stored, /top-secret|C:\\Users\\Alice|C:\/Users\/Alice/);
      assert.match(stored, /\[REDACTED_SECRET\]/);
      assert.match(stored, /\[LOCAL_PATH\]/);
      const investigationId = createInvestigation(database, { projectId: "project-a", triggerRunId: "private-run" });
      const output = handleGetRecentLogs({}, {
        database, projectId: "project-a", activeRunId: "private-run", investigationId, projectRoot: "C:/Users/Alice/work/project-a",
      });
      const serialized = JSON.stringify(output.evidence);
      assert.doesNotMatch(serialized, /C:\\Users\\Alice|C:\/Users\/Alice|top-secret/);
      assert.ok(output.evidence.every((item) => RunAgentEvidenceSchema.safeParse(item).success));
    } finally {
      database.close();
    }
  });

  it("isolates search by project and treats LIKE wildcard characters literally", () => {
    const database = openDatabase(":memory:");
    try {
      fixtureRun(database, { id: "a-wildcard", projectId: "project-a", events: [
        { stream: "stderr", content: "literal 100%_done" },
        { stream: "stderr", content: "not literal 100XXdone" },
      ] });
      fixtureRun(database, { id: "b-secret", projectId: "project-b", cwd: "C:/workspace/project-b", stderr: "literal 100%_done\n" });
      const rows = searchLogEvents(database, { projectId: "project-a", query: "100%_", limit: 20 });
      assert.equal(rows.length, 1);
      assert.match(rows[0].content, /literal 100%_done/);
      const investigationId = createInvestigation(database, { projectId: "project-a", triggerRunId: "a-wildcard" });
      const result = handleSearchLogs({ query: "100%_" }, {
        database, projectId: "project-a", activeRunId: "a-wildcard", investigationId, projectRoot: "C:/workspace/project-a",
      });
      assert.equal(result.evidence.filter((item) => item.sourceType !== "tool_result").length, 1);
      assert.ok(result.evidence.every((item) => !JSON.stringify(item).includes("project-b")));
    } finally {
      database.close();
    }
  });

  it("keeps recent-log ordering and returns stable, unique, bounded evidence", () => {
    const database = openDatabase(":memory:");
    try {
      fixtureRun(database, {
        id: "many-lines",
        events: Array.from({ length: 20 }, (_, sequence) => ({ stream: "stderr" as const, sequence, content: `${sequence}: ${"x".repeat(4_000)}` })),
      });
      const investigationId = createInvestigation(database, { projectId: "project-a", triggerRunId: "many-lines" });
      const result = handleGetRecentLogs({ limit: 20 }, {
        database, projectId: "project-a", activeRunId: "many-lines", investigationId, projectRoot: "C:/workspace/project-a",
      });
      const content = result.evidence.filter((item) => item.sourceType !== "tool_result");
      assert.ok(content.length <= 5);
      assert.equal(result.evidence.filter((item) => item.sourceType === "tool_result").length, 1);
      assert.ok(result.evidence.reduce((sum, item) => sum + item.excerpt.length, 0) <= 8_000);
      assert.equal(new Set(result.evidence.map((item) => item.id)).size, result.evidence.length);
      assert.ok(result.evidence.every((item) => item.id.length <= 80 && RunAgentEvidenceSchema.safeParse(item).success));
      assert.deepEqual(content.map((item) => Number(item.excerpt.match(/^\d+/)?.[0])), [18, 19]);
    } finally {
      database.close();
    }
  });

  it("blocks absolute and traversal context queries and redacts secrets from selected files", async () => {
    const database = openDatabase(":memory:");
    const root = temporaryDirectory();
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "config.ts"), "export const apiKey = 'sk-12345678901234567890';\nexport const mode = 'safe';\n");
      fixtureRun(database, { id: "context-run", cwd: root });
      const investigationId = createInvestigation(database, { projectId: "project-a", triggerRunId: "context-run" });
      const context = { database, projectId: "project-a", activeRunId: "context-run", investigationId, projectRoot: root };
      for (const query of ["/etc/passwd", "please inspect /etc/passwd", "../../.env", "please open ../../.env"]) {
        const blocked = await handleGetProjectContext({ query }, context);
        assert.equal(blocked.evidence.length, 1);
        assert.equal(blocked.evidence[0].sourceType, "tool_result");
        assert.match(blocked.evidence[0].excerpt, /file_skipped/);
      }
      const result = await handleGetProjectContext({ query: "config.ts", maxFiles: 3 }, context);
      const fileEvidence = result.evidence.find((item) => item.sourceType === "project_file");
      assert.ok(fileEvidence);
      assert.equal(fileEvidence.relativePath, "src/config.ts");
      assert.doesNotMatch(fileEvidence.excerpt, /sk-12345678901234567890/);
      assert.match(fileEvidence.excerpt, /\[REDACTED_SECRET\]/);
      assert.ok(RunAgentEvidenceSchema.safeParse(fileEvidence).success);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks symlinks that resolve outside the project root", async (t) => {
    const database = openDatabase(":memory:");
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    try {
      writeFileSync(join(outside, "private.ts"), "export const credential = 'hidden';\n");
      try {
        symlinkSync(outside, join(root, "outside-secret.ts"), "junction");
      } catch {
        t.skip("This Windows environment does not allow unprivileged symlink creation");
        return;
      }
      fixtureRun(database, { id: "symlink-run", cwd: root });
      const investigationId = createInvestigation(database, { projectId: "project-a", triggerRunId: "symlink-run" });
      const result = await handleGetProjectContext({ query: "outside-secret.ts", maxFiles: 1 }, {
        database, projectId: "project-a", activeRunId: "symlink-run", investigationId, projectRoot: root,
      });
      assert.ok(result.evidence.every((item) => item.sourceType !== "project_file" || item.relativePath !== "outside-secret.ts"));
      assert.ok(result.evidence.some((item) => item.sourceType === "tool_result" && /skipped|No relevant/i.test(item.excerpt)));
      assert.doesNotMatch(JSON.stringify(result.evidence), /private\.ts|hidden/);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("enforces 64 KiB per-file and 256 KiB aggregate context read limits", async () => {
    const database = openDatabase(":memory:");
    const root = temporaryDirectory();
    try {
      for (let index = 0; index < 5; index += 1) {
        writeFileSync(join(root, `config-${index}.ts`), "x".repeat(65_536));
      }
      fixtureRun(database, { id: "large-context-run", cwd: root });
      const investigationId = createInvestigation(database, { projectId: "project-a", triggerRunId: "large-context-run" });
      const result = await handleGetProjectContext({ query: "config", maxFiles: 5 }, {
        database, projectId: "project-a", activeRunId: "large-context-run", investigationId, projectRoot: root,
      });
      const files = result.evidence.filter((item) => item.sourceType === "project_file");
      assert.ok(files.length <= 5);
      assert.ok(files.every((item) => item.excerpt.length <= 4_000));
      assert.ok(result.evidence.reduce((sum, item) => sum + item.excerpt.length, 0) <= 8_000);
      assert.ok(result.evidence.filter((item) => item.sourceType === "tool_result").length <= 1);
      assert.ok(result.evidence.some((item) => item.sourceType === "tool_result" && /truncated|skipped/i.test(item.excerpt)));
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates unknown dispatcher inputs and audits valid calls without exposing raw request data", async () => {
    const database = openDatabase(":memory:");
    const root = temporaryDirectory();
    try {
      fixtureRun(database, { id: "dispatch-run", cwd: root, stderr: "failure\n" });
      const investigationId = createInvestigation(database, { projectId: "project-a", triggerRunId: "dispatch-run" });
      const context = { database, projectId: "project-a", activeRunId: "dispatch-run", investigationId, projectRoot: root, round: 1 };
      const invalid = await dispatchToolRequest({ toolName: "runCommand", input: { command: "delete everything" } }, context);
      assert.equal(invalid.accepted, false);
      assert.equal(invalid.evidence[0].sourceType, "tool_result");
      const valid = await dispatchToolRequest({ toolName: "getRecentLogs", input: {} }, context);
      assert.equal(valid.accepted, true);
      const invalidAudit = database.prepare("SELECT tool_name, outcome_status FROM investigation_tool_calls WHERE tool_name = 'invalid'").get() as Record<string, string>;
      assert.equal(invalidAudit.tool_name, "invalid");
      assert.equal(invalidAudit.outcome_status, "error");
      const audit = database.prepare("SELECT tool_name, outcome_status, safe_summary FROM investigation_tool_calls WHERE tool_name = 'getRecentLogs'").get() as Record<string, string>;
      assert.equal(audit.tool_name, "getRecentLogs");
      assert.equal(audit.outcome_status, "ok");
      assert.doesNotMatch(audit.safe_summary, /C:\\|delete everything/);
      assert.ok(listEvidence(database, investigationId).length > 0);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
