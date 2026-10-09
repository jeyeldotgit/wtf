import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";
import { redactForStorageOrModel } from "../../shared/redaction.js";
import { withTransaction } from "../database.js";

export type RunStatus = "running" | "completed" | "failed" | "cancelled";
export type RunStreamEvent = { stream: "stdout" | "stderr"; content: string; sequence?: number };

export type RunRecord = {
  id: string;
  projectId: string;
  investigationId: string | null;
  commandDisplay: string;
  cwd: string;
  startTime: string;
  endTime: string | null;
  exitCode: number | null;
  status: RunStatus;
  stdoutBytes: number;
  stderrBytes: number;
};

export function createRun(database: DatabaseSync, input: {
  id?: string;
  projectId: string;
  commandDisplay: string;
  cwd: string;
  startTime?: string;
}): RunRecord {
  const id = input.id ?? randomUUID();
  const startTime = input.startTime ?? new Date().toISOString();
  const commandDisplay = redactForStorageOrModel(input.commandDisplay, [input.cwd]);
  database.prepare(`
    INSERT INTO runs (id, project_id, command_display, cwd, start_time, status)
    VALUES (?, ?, ?, ?, ?, 'running')
  `).run(id, input.projectId, commandDisplay, input.cwd, startTime);
  return {
    id,
    projectId: input.projectId,
    investigationId: null,
    commandDisplay,
    cwd: input.cwd,
    startTime,
    endTime: null,
    exitCode: null,
    status: "running",
    stdoutBytes: 0,
    stderrBytes: 0,
  };
}

export function completeRun(database: DatabaseSync, input: {
  runId: string;
  projectId: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  events?: RunStreamEvent[];
  endTime?: string;
}): void {
  const run = getRun(database, input.projectId, input.runId);
  if (!run) throw new Error("Run not found in the active project");
  if (run.status !== "running") throw new Error("Run is already complete");

  withTransaction(database, () => completeRunWithinTransaction(database, input, run));
}

function completeRunWithinTransaction(database: DatabaseSync, input: {
  runId: string;
  projectId: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  events?: RunStreamEvent[];
  endTime?: string;
}, run: RunRecord): void {
  const stdout = input.stdout ?? "";
  const stderr = input.stderr ?? "";
  const events: RunStreamEvent[] = input.events ?? [
    ...stdout.split(/(?<=\n)/).filter(Boolean).map((content) => ({ stream: "stdout" as const, content })),
    ...stderr.split(/(?<=\n)/).filter(Boolean).map((content) => ({ stream: "stderr" as const, content })),
  ];
  const sorted = events.map((event, index) => ({ ...event, sequence: event.sequence ?? index }));
  const status: RunStatus = input.exitCode === 0 ? "completed" : "failed";
  const endTime = input.endTime ?? new Date().toISOString();
  const stdoutBytes = input.stdout === undefined
    ? Buffer.byteLength(sorted.filter((event) => event.stream === "stdout").map((event) => event.content).join(""))
    : Buffer.byteLength(stdout);
  const stderrBytes = input.stderr === undefined
    ? Buffer.byteLength(sorted.filter((event) => event.stream === "stderr").map((event) => event.content).join(""))
    : Buffer.byteLength(stderr);

  for (const event of sorted) {
    database.prepare(`
      INSERT INTO log_events (run_id, stream, sequence, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.runId,
      event.stream,
      event.sequence,
      redactForStorageOrModel(event.content, [run.cwd]),
      endTime,
    );
  }
  database.prepare(`
    UPDATE runs
    SET end_time = ?, exit_code = ?, status = ?, stdout_bytes = ?, stderr_bytes = ?
    WHERE id = ? AND project_id = ? AND status = 'running'
  `).run(endTime, input.exitCode, status, stdoutBytes, stderrBytes, input.runId, input.projectId);
}

export function getRun(database: DatabaseSync, projectId: string, runId: string): RunRecord | undefined {
  const row = database.prepare(`
    SELECT id, project_id, investigation_id, command_display, cwd, start_time, end_time, exit_code,
      status, stdout_bytes, stderr_bytes
    FROM runs WHERE id = ? AND project_id = ?
  `).get(runId, projectId) as Record<string, string | number | null> | undefined;
  return row ? mapRun(row) : undefined;
}

export function getRunById(database: DatabaseSync, runId: string): RunRecord | undefined {
  const row = database.prepare(`
    SELECT id, project_id, investigation_id, command_display, cwd, start_time, end_time, exit_code,
      status, stdout_bytes, stderr_bytes
    FROM runs WHERE id = ?
  `).get(runId) as Record<string, string | number | null> | undefined;
  return row ? mapRun(row) : undefined;
}

export function createCompletedRun(database: DatabaseSync, input: {
  id?: string;
  projectId: string;
  commandDisplay: string;
  cwd: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  events?: RunStreamEvent[];
  startTime?: string;
  endTime?: string;
}): RunRecord {
  return withTransaction(database, () => {
    const run = createRun(database, input);
    const completedInput = { ...input, runId: run.id };
    completeRunWithinTransaction(database, completedInput, run);
    const completed = getRun(database, input.projectId, run.id);
    if (!completed) throw new Error("Completed run could not be read back");
    return completed;
  });
}

export function purgeExpiredRuns(database: DatabaseSync, now = new Date(), retentionDays = 14): number {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new RangeError("retentionDays must be an integer between 1 and 3650");
  }
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return Number(database.prepare("DELETE FROM runs WHERE start_time < ?").run(cutoff).changes);
}

export function clearHistory(database: DatabaseSync, projectId: string, confirmed: boolean): number {
  if (!confirmed) throw new Error("Clearing history requires explicit user confirmation");
  return Number(database.prepare("DELETE FROM runs WHERE project_id = ?").run(projectId).changes);
}

function mapRun(row: Record<string, string | number | null>): RunRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    investigationId: row.investigation_id === null ? null : String(row.investigation_id),
    commandDisplay: String(row.command_display),
    cwd: String(row.cwd),
    startTime: String(row.start_time),
    endTime: row.end_time === null ? null : String(row.end_time),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    status: String(row.status) as RunStatus,
    stdoutBytes: Number(row.stdout_bytes),
    stderrBytes: Number(row.stderr_bytes),
  };
}
