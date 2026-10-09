import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentRunError } from "../../src/agents/run-agent.js";
import { PERSISTENCE_BYTE_LIMIT } from "../../src/capture/types.js";
import type { RunAgentInput } from "../../src/agents/schemas.js";
import { RunSession, type RunSessionEvent } from "../../src/session/run-session.js";
import { openDatabase } from "../../src/storage/database.js";
import { getRun, getRunById } from "../../src/storage/repositories/runs.js";
import { getLogEvents } from "../../src/storage/repositories/log-events.js";

function setup() {
  const database = openDatabase(":memory:");
  const projectRoot = mkdtempSync(join(tmpdir(), "wtf-run-session-"));
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  return {
    database,
    projectRoot,
    close() {
      database.close();
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

function diagnosis(input: RunAgentInput) {
  return {
    kind: "diagnosis",
    diagnosis: {
      summary: "The command failed because a value was unavailable.",
      observations: [{ statement: "The captured error identifies the failed operation.", evidenceIds: [input.evidence[0].id] }],
      beginnerExplanation: ["The program tried to use a value that was not available."],
      missingInformation: [],
    },
  };
}

describe("run session", () => {
  it("persists successful commands and does not invoke investigation", async () => {
    const context = setup();
    const events: RunSessionEvent[] = [];
    let agentCalls = 0;
    const session = new RunSession({
      database: context.database,
      projectRoot: context.projectRoot,
      projectId: "session-project",
      shell: "/bin/sh",
      runAgent: async () => {
        agentCalls += 1;
        throw new Error("successful commands must not invoke the agent");
      },
    });
    const unsubscribe = session.subscribe((event) => events.push(event));
    try {
      const result = await session.execute("printf 'successful output\\n'");
      assert.ok(result);
      assert.equal(result.run.status, "completed");
      assert.equal(result.run.exitCode, 0);
      assert.equal(result.investigation, undefined);
      assert.equal(agentCalls, 0);
      assert.ok(getRun(context.database, "session-project", result.run.id));
      assert.ok(events.some((event) => event.type === "output" && event.text.includes("successful output")));
    } finally {
      unsubscribe();
      await session.close();
      context.close();
    }
  });

  it("persists a redacted failure before invoking the investigation service", async () => {
    const context = setup();
    const events: RunSessionEvent[] = [];
    let agentCalls = 0;
    const session = new RunSession({
      database: context.database,
      projectRoot: context.projectRoot,
      projectId: "session-project",
      shell: "/bin/sh",
      runAgent: async (input) => {
        agentCalls += 1;
        const stored = getRun(context.database, "session-project", input.runId);
        assert.ok(stored);
        const lines = getLogEvents(context.database, "session-project", input.runId, 10);
        assert.ok(lines.length > 0);
        assert.doesNotMatch(lines.map((line) => line.content).join(""), /sk-proj-session-secret/);
        return diagnosis(input);
      },
    });
    const unsubscribe = session.subscribe((event) => events.push(event));
    try {
      const result = await session.execute("printf 'API_KEY=sk-proj-session-secret-123456789\\n' >&2; false");
      assert.ok(result);
      assert.equal(result.run.status, "failed");
      assert.equal(result.run.exitCode, 1);
      assert.equal(result.investigation?.status, "diagnosed");
      assert.equal(agentCalls, 1);
      assert.ok(events.some((event) => event.type === "investigation_started"));
      assert.ok(events.some((event) => event.type === "investigation_completed"));
    } finally {
      unsubscribe();
      await session.close();
      context.close();
    }
  });

  it("enforces the combined output limit before persisting a completed command", async () => {
    const context = setup();
    const session = new RunSession({
      database: context.database,
      projectRoot: context.projectRoot,
      projectId: "session-project",
      shell: "/bin/sh",
      onOutput: () => undefined,
    });
    try {
      const result = await session.execute("printf '%2100000s' | tr ' ' x");
      assert.ok(result);
      assert.equal(result.run.status, "completed");
      assert.equal(result.captured.truncation.stdoutTruncated, true);
      assert.ok(Buffer.byteLength(result.captured.stdout) + Buffer.byteLength(result.captured.stderr) <= PERSISTENCE_BYTE_LIMIT);
      const events = getLogEvents(context.database, "session-project", result.run.id, 5);
      assert.ok(events.some((event) => event.content.includes("TRUNCATED stdout")));
    } finally {
      await session.close();
      context.close();
    }
  });

  it("keeps the command record when local inference is unavailable", async () => {
    const context = setup();
    const session = new RunSession({
      database: context.database,
      projectRoot: context.projectRoot,
      projectId: "session-project",
      shell: "/bin/sh",
      runAgent: async () => {
        throw new AgentRunError("offline", "connection");
      },
    });
    try {
      const result = await session.execute("printf 'captured\\n' >&2; false");
      assert.ok(result);
      assert.equal(result.run.status, "failed");
      assert.ok(getRunById(context.database, result.run.id));
      assert.equal(result.investigation?.status, "failed");
      assert.equal(result.investigation?.lastErrorCode, "agent_unavailable");
    } finally {
      await session.close();
      context.close();
    }
  });

  it("persists a cancelled run when the session closes during a command", async () => {
    const context = setup();
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const session = new RunSession({
      database: context.database,
      projectRoot: context.projectRoot,
      projectId: "session-project",
      shell: "/bin/sh",
    });
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "command_started") resolveStarted?.();
    });
    try {
      const pending = session.execute("sleep 20");
      await started;
      await new Promise((resolve) => setTimeout(resolve, 50));
      await session.close();
      const result = await pending;
      assert.ok(result);
      assert.equal(result.run.status, "cancelled");
      assert.equal(result.run.exitCode, null);
      assert.equal(result.run.signal, "SIGTERM");
      assert.equal(getRun(context.database, "session-project", result.run.id)?.status, "cancelled");
      assert.equal(result.investigation, undefined);
    } finally {
      unsubscribe();
      await session.close();
      context.close();
    }
  });

  it("stores a shell signal as a cancelled run without starting diagnosis", async () => {
    const context = setup();
    let agentCalls = 0;
    const session = new RunSession({
      database: context.database,
      projectRoot: context.projectRoot,
      projectId: "session-project",
      shell: "/bin/sh",
      runAgent: async () => {
        agentCalls += 1;
        throw new Error("signal-terminated commands must not be diagnosed");
      },
    });
    try {
      const result = await session.execute("kill -TERM $$");
      assert.ok(result);
      assert.equal(result.run.status, "cancelled");
      assert.equal(result.run.exitCode, null);
      assert.equal(result.run.signal, "SIGTERM");
      assert.equal(result.investigation, undefined);
      assert.equal(agentCalls, 0);
    } finally {
      await session.close();
      context.close();
    }
  });
});
