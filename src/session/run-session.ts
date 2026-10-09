import type { DatabaseSync } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
import { redactForStorageOrModel } from "../shared/redaction.js";
import { normalizeOutput } from "../capture/normalize-output.js";
import { COMMAND_DISPLAY_LIMIT, type CapturedRun } from "../capture/types.js";
import { ManagedShell } from "../capture/managed-shell.js";
import { createCompletedRun, type RunRecord } from "../storage/repositories/runs.js";
import { listEvidence } from "../storage/repositories/evidence.js";
import type { RunAgentEvidence } from "../agents/schemas.js";
import { runInvestigation, type RunInvestigationDependencies } from "../investigation/run-investigation.js";
import type { DispatchContext, DispatchOptions, DispatchResult } from "../investigation/tool-dispatcher.js";
import type { InvestigationRecord } from "../storage/repositories/investigations.js";
import { openDatabase } from "../storage/database.js";
import { resolveProjectContext } from "./project-id.js";

export type RunSessionEvent =
  | { type: "command_started"; runId: string; commandDisplay: string; startTime: number }
  | { type: "output"; runId: string; stream: "stdout" | "stderr"; text: string }
  | { type: "session_error"; message: string }
  | { type: "command_completed"; run: RunRecord; captured: CapturedRun }
  | { type: "investigation_started"; runId: string }
  | { type: "investigation_completed"; run: RunRecord; investigation: InvestigationRecord; evidence: RunAgentEvidence[] }
  | { type: "investigation_error"; runId: string; message: string }
  | { type: "session_ended"; code: number | null; signal: string | null };

export type RunSessionResult = {
  run: RunRecord;
  captured: CapturedRun;
  investigation?: InvestigationRecord;
  evidence?: RunAgentEvidence[];
  investigationError?: string;
};

export type RunSessionOptions = {
  database?: DatabaseSync;
  projectId?: string;
  projectRoot?: string;
  shell?: string;
  onOutput?: (stream: "stdout" | "stderr", chunk: Buffer, runId?: string) => void;
  runAgent?: RunInvestigationDependencies["runAgent"];
  dispatchToolRequest?: (request: unknown, context: DispatchContext, options?: DispatchOptions) => Promise<DispatchResult>;
};

type SessionListener = (event: RunSessionEvent) => void;

export class RunSession {
  readonly database: DatabaseSync;
  readonly projectId: string;
  readonly projectRoot: string;
  private readonly ownsDatabase: boolean;
  private readonly shell: ManagedShell;
  private readonly listeners = new Set<SessionListener>();
  private readonly decoders = new Map<string, Record<"stdout" | "stderr", StringDecoder>>();
  private activeRunId: string | undefined;
  private readonly runAgent: RunSessionOptions["runAgent"];
  private readonly dispatchToolRequest: RunSessionOptions["dispatchToolRequest"];
  private activeCommand = false;
  private activeCommandDone: Promise<void> | undefined;
  private resolveActiveCommand: (() => void) | undefined;
  private closePromise: Promise<void> | undefined;
  private pendingShellExit: { code: number | null; signal: string | null } | undefined;
  private closed = false;

  constructor(options: RunSessionOptions = {}) {
    const project = resolveProjectContext(options.projectRoot ?? process.cwd());
    this.projectRoot = project.projectRoot;
    this.projectId = options.projectId ?? project.projectId;
    this.ownsDatabase = options.database === undefined;
    this.database = options.database ?? openDatabase();
    this.runAgent = options.runAgent;
    this.dispatchToolRequest = options.dispatchToolRequest;
    this.shell = new ManagedShell({
      shell: options.shell,
      cwd: this.projectRoot,
      onCommandStart: (runId, commandText, startTime, cwd) => {
        const commandDisplay = redactForStorageOrModel(commandText, [this.projectRoot, cwd]).slice(0, COMMAND_DISPLAY_LIMIT);
        this.activeRunId = runId;
        this.decoders.set(runId, { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") });
        this.publish({ type: "command_started", runId, commandDisplay, startTime });
      },
      onOutput: (stream, chunk, runId) => {
        try {
          options.onOutput?.(stream, chunk, runId);
        } catch {}
        if (!runId) return;
        const text = this.decoders.get(runId)?.[stream].write(chunk) ?? chunk.toString("utf8");
        if (text) this.publish({ type: "output", runId, stream, text });
      },
      onExit: (code, signal) => {
        if (this.closed) return;
        if (this.activeCommand) this.pendingShellExit = { code, signal };
        else this.publish({ type: "session_ended", code, signal });
      },
    });
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async execute(commandText: string): Promise<RunSessionResult | undefined> {
    if (this.closed) throw new Error("The run session is closed");
    if (!commandText.trim()) return undefined;
    this.activeCommand = true;
    this.activeCommandDone = new Promise((resolve) => { this.resolveActiveCommand = resolve; });

    try {
      const captured = await this.shell.execute(commandText);
      this.flushOutput(captured.runId);
      this.activeRunId = undefined;
      const roots = [this.projectRoot, captured.localMetadata.cwd];
      const normalized = normalizeOutput({
        ...captured,
        commandText: redactForStorageOrModel(captured.commandText, roots),
        stdout: redactForStorageOrModel(captured.stdout, roots),
        stderr: redactForStorageOrModel(captured.stderr, roots),
      });
      const run = createCompletedRun(this.database, {
        id: normalized.runId,
        projectId: this.projectId,
        commandDisplay: normalized.commandText,
        cwd: normalized.localMetadata.cwd,
        exitCode: normalized.exitStatus,
        signal: normalized.signal,
        stdout: normalized.stdout,
        stderr: normalized.stderr,
        startTime: new Date(normalized.startTime).toISOString(),
        endTime: new Date(normalized.startTime + normalized.durationMs).toISOString(),
      });
      this.publish({ type: "command_completed", run, captured: normalized });

      if (this.closed || normalized.exitStatus === null || normalized.exitStatus === 0) return { run, captured: normalized };

      this.publish({ type: "investigation_started", runId: run.id });
      try {
        const investigation = await runInvestigation(run.id, {
          database: this.database,
          projectId: this.projectId,
          projectRoot: this.projectRoot,
          runAgent: this.runAgent,
          dispatchToolRequest: this.dispatchToolRequest,
        });
        const evidence = listEvidence(this.database, investigation.id);
        this.publish({ type: "investigation_completed", run, investigation, evidence });
        return { run, captured: normalized, investigation, evidence };
      } catch {
        const message = "The run was saved, but its investigation could not be completed.";
        this.publish({ type: "investigation_error", runId: run.id, message });
        return { run, captured: normalized, investigationError: message };
      }
    } catch (error) {
      if (this.activeRunId) {
        this.flushOutput(this.activeRunId);
        this.activeRunId = undefined;
      }
      this.publish({ type: "session_error", message: "The command could not be captured or persisted." });
      throw error;
    } finally {
      this.activeCommand = false;
      const resolveActiveCommand = this.resolveActiveCommand;
      this.resolveActiveCommand = undefined;
      this.activeCommandDone = undefined;
      resolveActiveCommand?.();
      if (this.pendingShellExit && !this.closed) {
        const exit = this.pendingShellExit;
        this.pendingShellExit = undefined;
        this.publish({ type: "session_ended", code: exit.code, signal: exit.signal });
      }
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return;
    this.closed = true;
    this.shell.destroy();
    this.listeners.clear();
    this.closePromise = (this.activeCommandDone ?? Promise.resolve()).then(() => {
      if (this.ownsDatabase) this.database.close();
    });
    return this.closePromise;
  }

  private flushOutput(runId: string): void {
    const decoders = this.decoders.get(runId);
    if (!decoders) return;
    for (const stream of ["stdout", "stderr"] as const) {
      const text = decoders[stream].end();
      if (text) this.publish({ type: "output", runId, stream, text });
    }
    this.decoders.delete(runId);
  }

  private publish(event: RunSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        continue;
      }
    }
  }
}
