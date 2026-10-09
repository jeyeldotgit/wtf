import type { DatabaseSync } from "node:sqlite";
import {
  RunAgentInputSchema,
  RunAgentResultSchema,
  ToolRequestSchema,
  validateDiagnosisForInput,
  type Diagnosis,
  type RunAgentInput,
  type ToolRequest,
} from "../agents/schemas.js";
import {
  AgentRunError,
  DEFAULT_AGENT_MODEL,
  runAgent as defaultRunAgent,
  type RunAgentOptions,
} from "../agents/run-agent.js";
import { RUN_AGENT_PROMPT_VERSION } from "../agents/system/prompt.js";
import { buildRunAgentInput } from "../context/build-run-agent-input.js";
import {
  appendToolEvidence,
  capInitialRunAgentInput,
  toolEvidenceBudgetExhausted,
} from "../context/append-tool-evidence.js";
import type { CapturedRun } from "../capture/types.js";
import {
  dispatchToolRequest as defaultDispatchToolRequest,
  type DispatchContext,
  type DispatchOptions,
  type DispatchResult,
} from "./tool-dispatcher.js";
import { getLogEvents } from "../storage/repositories/log-events.js";
import { getInvestigation, getInvestigationByTriggerRun, createInvestigation, transitionInvestigation, type InvestigationRecord } from "../storage/repositories/investigations.js";
import { listEvidence, persistEvidence } from "../storage/repositories/evidence.js";
import { completeToolCall, getPendingToolCall, getToolCalls, hashToolRequest, recordPendingToolCall } from "../storage/repositories/tool-calls.js";
import { getRun, getRunById } from "../storage/repositories/runs.js";
import { openDatabase, withTransaction } from "../storage/database.js";

export const MAX_TOOL_ROUNDS = 3;
const INITIAL_LOG_EVENT_LIMIT = 10_000;

export type RunInvestigationDependencies = {
  database: DatabaseSync;
  projectId: string;
  projectRoot: string;
  runAgent?: (input: RunAgentInput, options: RunAgentOptions) => Promise<unknown>;
  dispatchToolRequest?: (request: unknown, context: DispatchContext, options?: DispatchOptions) => Promise<DispatchResult>;
};

type FailureDetails = { code: string; summary: string };

class InvestigationFailure extends Error {
  constructor(readonly code: string, readonly summary: string) {
    super(summary);
    this.name = "InvestigationFailure";
  }
}

export async function runInvestigation(
  triggerRunId: string,
  options: Partial<RunInvestigationDependencies> = {},
): Promise<InvestigationRecord> {
  const ownsDatabase = options.database === undefined;
  const database = options.database ?? openDatabase();
  try {
    const run = options.projectId
      ? getRun(database, options.projectId, triggerRunId)
      : getRunById(database, triggerRunId);
    if (!run) throw new InvestigationFailure("run_not_found", "The failed run is unavailable in this project.");
    return await runInvestigationWithDependencies(triggerRunId, {
      database,
      projectId: options.projectId ?? run.projectId,
      projectRoot: options.projectRoot ?? run.cwd,
      runAgent: options.runAgent,
      dispatchToolRequest: options.dispatchToolRequest,
    });
  } finally {
    if (ownsDatabase) database.close();
  }
}

async function runInvestigationWithDependencies(triggerRunId: string, dependencies: RunInvestigationDependencies): Promise<InvestigationRecord> {
  const { database, projectId, projectRoot } = dependencies;
  let investigationId: string | undefined;
  let toolRoundCount = 0;

  try {
    const run = getRun(database, projectId, triggerRunId);
    if (!run) throw new InvestigationFailure("run_not_found", "The failed run is unavailable in this project.");
    if (run.status !== "failed" || run.exitCode === null || run.exitCode === 0) {
      throw new InvestigationFailure("run_not_failed", "Only completed failed runs can start an investigation.");
    }

    let investigation = getInvestigationByTriggerRun(database, projectId, triggerRunId);
    if (investigation && isTerminal(investigation.status)) return investigation;
    if (!investigation) {
      investigationId = createInvestigation(database, { projectId, triggerRunId });
      investigation = getInvestigation(database, projectId, investigationId);
    } else {
      investigationId = investigation.id;
      if (investigation.status === "failed" || investigation.status === "awaiting_user") {
        transitionInvestigation(database, { id: investigation.id, projectId, status: "investigating" });
        investigation = getInvestigation(database, projectId, investigation.id);
      }
    }
    if (!investigation || !investigationId) {
      throw new InvestigationFailure("investigation_unavailable", "The investigation record could not be loaded.");
    }
    if (investigation.status !== "investigating") {
      throw new InvestigationFailure("invalid_investigation_state", "The investigation is not in a resumable state.");
    }

    const activeInvestigationId = investigation.id;
    let input = makeInitialInput(database, projectId, run);
    const priorEvidence = listEvidence(database, activeInvestigationId);
    const restored = appendToolEvidence(input, priorEvidence);
    input = restored.input;
    if (restored.appendedEvidence.length > 0) {
      withTransaction(database, () => persistEvidenceBatch(database, activeInvestigationId, restored.appendedEvidence));
    }

    const calls = getToolCalls(database, investigationId);
    const pendingCalls = calls.filter((call) => call.outcomeStatus === "pending");
    if (pendingCalls.length > 1) {
      throw new InvestigationFailure("pending_ledger_invalid", "The investigation has more than one pending lookup.");
    }
    const completedCalls = calls.filter((call) => call.outcomeStatus !== "pending" && call.toolName !== "invalid");
    toolRoundCount = Math.max(investigation.toolRoundCount, completedCalls.length);
    const completedHashes = new Set(completedCalls.map((call) => call.requestHash));
    let forceNoTools = restored.budgetExhausted || toolEvidenceBudgetExhausted(input) || toolRoundCount >= MAX_TOOL_ROUNDS;

    const pending = pendingCalls[0] ?? getPendingToolCall(database, investigationId);
    if (pending) {
      const recovered = await executePendingRequest(pending, input, toolRoundCount, dependencies, investigation);
      input = recovered.input;
      toolRoundCount = recovered.toolRoundCount;
      completedHashes.add(pending.requestHash);
      forceNoTools = recovered.forceNoTools || toolEvidenceBudgetExhausted(input) || toolRoundCount >= MAX_TOOL_ROUNDS;
    }

    const agent = dependencies.runAgent ?? defaultRunAgent;
    const dispatcher = dependencies.dispatchToolRequest ?? defaultDispatchToolRequest;

    while (true) {
      const allowTools = !forceNoTools;
      let result;
      try {
        const rawResult = await agent(input, { allowTools });
        result = RunAgentResultSchema.parse(rawResult);
        if (result.kind === "diagnosis") {
          const diagnosis = validateDiagnosisForInput(result.diagnosis, input);
          return persistDiagnosis(database, investigationId, projectId, diagnosis, toolRoundCount);
        }
      } catch (error) {
        if (allowTools && isInvalidAgentOutput(error)) {
          forceNoTools = true;
          continue;
        }
        throw error;
      }

      if (!allowTools) {
        throw new InvestigationFailure("tools_disabled_response", "The final response requested a lookup after tools were disabled.");
      }

      const request = ToolRequestSchema.parse(result.requests[0]);
      const requestHash = hashToolRequest(request.toolName, request.input);
      if (completedHashes.has(requestHash) || toolEvidenceBudgetExhausted(input) || toolRoundCount >= MAX_TOOL_ROUNDS) {
        forceNoTools = true;
        continue;
      }

      const round = toolRoundCount + 1;
      const pendingRequest = recordPendingToolCall(database, {
        investigationId,
        round,
        request,
        localRoots: [projectRoot],
      });
      if (pendingRequest.record.outcomeStatus !== "pending") {
        completedHashes.add(requestHash);
        forceNoTools = true;
        continue;
      }
      const ledgerRequest = parseLedgerRequest(pendingRequest.record.requestJson, request.toolName);
      const context = dispatchContext(projectId, projectRoot, triggerRunId, investigationId, round, database);
      const dispatch = await dispatcher(ledgerRequest, context, { persist: false });
      const appended = appendToolEvidence(input, dispatch.evidence);
      const nextRoundCount = toolRoundCount + 1;
      persistToolOutcome(database, investigationId, projectId, pendingRequest.record.requestHash, dispatch, appended, nextRoundCount);
      input = appended.input;
      toolRoundCount = nextRoundCount;
      completedHashes.add(requestHash);
      forceNoTools = !dispatch.accepted || appended.budgetExhausted || toolEvidenceBudgetExhausted(input) || toolRoundCount >= MAX_TOOL_ROUNDS;
    }
  } catch (error) {
    if (!investigationId) throw error;
    const failure = failureDetails(error);
    return failInvestigation(database, projectId, investigationId, toolRoundCount, failure);
  }
}

async function executePendingRequest(
  pending: ReturnType<typeof getPendingToolCall> & {},
  input: RunAgentInput,
  priorRounds: number,
  dependencies: RunInvestigationDependencies,
  investigation: InvestigationRecord,
): Promise<{ input: RunAgentInput; toolRoundCount: number; forceNoTools: boolean }> {
  if (pending.round > MAX_TOOL_ROUNDS || priorRounds >= MAX_TOOL_ROUNDS || toolEvidenceBudgetExhausted(input)) {
    const toolRoundCount = Math.min(MAX_TOOL_ROUNDS, Math.max(priorRounds, pending.round));
    withTransaction(dependencies.database, () => {
      completeToolCall(dependencies.database, {
        investigationId: investigation.id,
        requestHash: pending.requestHash,
        outcomeStatus: "error",
        safeSummary: "The pending lookup was skipped because the investigation budget was exhausted.",
      });
      transitionInvestigation(dependencies.database, {
        id: investigation.id,
        projectId: dependencies.projectId,
        status: "investigating",
        toolRoundCount,
      });
    });
    return { input, toolRoundCount, forceNoTools: true };
  }

  let request: ToolRequest;
  try {
    request = parseLedgerRequest(pending.requestJson, pending.toolName);
  } catch {
    throw new InvestigationFailure("pending_request_invalid", "A pending lookup could not be safely restored.");
  }
  const context = dispatchContext(
    dependencies.projectId,
    dependencies.projectRoot,
    investigation.triggerRunId,
    investigation.id,
    pending.round,
    dependencies.database,
  );
  const dispatcher = dependencies.dispatchToolRequest ?? defaultDispatchToolRequest;
  const dispatch = await dispatcher(request, context, { persist: false });
  const appended = appendToolEvidence(input, dispatch.evidence);
  const toolRoundCount = Math.max(priorRounds, pending.round);
  persistToolOutcome(dependencies.database, investigation.id, dependencies.projectId, pending.requestHash, dispatch, appended, toolRoundCount);
  return {
    input: appended.input,
    toolRoundCount,
    forceNoTools: !dispatch.accepted || appended.budgetExhausted,
  };
}

function makeInitialInput(database: DatabaseSync, projectId: string, run: NonNullable<ReturnType<typeof getRun>>): RunAgentInput {
  const events = getLogEvents(database, projectId, run.id, INITIAL_LOG_EVENT_LIMIT);
  const startTime = Date.parse(run.startTime);
  const endTime = run.endTime === null ? startTime : Date.parse(run.endTime);
  const captured: CapturedRun = {
    runId: run.id,
    commandText: run.commandDisplay,
    stdout: streamTail(events, "stdout"),
    stderr: streamTail(events, "stderr"),
    exitStatus: run.exitCode,
    startTime: Number.isFinite(startTime) ? startTime : Date.now(),
    durationMs: Number.isFinite(endTime - startTime) ? Math.max(0, endTime - startTime) : 0,
    localMetadata: { cwd: run.cwd, shell: "" },
    truncation: { stdoutTruncated: false, stderrTruncated: false },
  };
  const input = buildRunAgentInput(captured);
  if (!input) throw new InvestigationFailure("run_input_unavailable", "A valid failed-run input could not be built.");
  return capInitialRunAgentInput(RunAgentInputSchema.parse(input));
}

function streamTail(events: ReturnType<typeof getLogEvents>, stream: "stdout" | "stderr"): string {
  const limit = 16_000;
  let output = "";
  for (const event of events) {
    if (event.stream !== stream) continue;
    const content = event.content.length > limit ? event.content.slice(-limit) : event.content;
    output = `${output}${content}`.slice(-limit);
  }
  return output;
}

function dispatchContext(
  projectId: string,
  projectRoot: string,
  activeRunId: string,
  investigationId: string,
  round: number,
  database: DatabaseSync,
): DispatchContext {
  return { database, projectId, projectRoot, activeRunId, investigationId, round };
}

function parseLedgerRequest(requestJson: string, expectedToolName?: string): ToolRequest {
  const request = ToolRequestSchema.parse(JSON.parse(requestJson));
  if (expectedToolName && request.toolName !== expectedToolName) {
    throw new InvestigationFailure("pending_request_invalid", "A pending lookup did not match its recorded tool.");
  }
  return request;
}

function persistToolOutcome(
  database: DatabaseSync,
  investigationId: string,
  projectId: string,
  requestHash: string,
  dispatch: DispatchResult,
  appended: ReturnType<typeof appendToolEvidence>,
  toolRoundCount: number,
): void {
  withTransaction(database, () => {
    completeToolCall(database, {
      investigationId,
      requestHash,
      outcomeStatus: dispatch.accepted ? dispatch.outcomeStatus : "error",
      safeSummary: dispatch.safeSummary,
    });
    persistEvidenceBatch(database, investigationId, appended.appendedEvidence);
    transitionInvestigation(database, {
      id: investigationId,
      projectId,
      status: "investigating",
      toolRoundCount,
    });
  });
}

function persistEvidenceBatch(database: DatabaseSync, investigationId: string, evidence: RunAgentInput["evidence"]): void {
  for (const item of evidence) persistEvidence(database, investigationId, item);
}

function persistDiagnosis(
  database: DatabaseSync,
  investigationId: string,
  projectId: string,
  diagnosis: Diagnosis,
  toolRoundCount: number,
): InvestigationRecord {
  const status = diagnosis.missingInformation.length > 0
    ? "needs_input"
    : diagnosis.proposedFix
      ? "awaiting_patch_approval"
      : "diagnosed";
  transitionInvestigation(database, {
    id: investigationId,
    projectId,
    status,
    diagnosis: JSON.stringify(diagnosis),
    modelVersion: process.env.WTF_MODEL ?? DEFAULT_AGENT_MODEL,
    promptVersion: RUN_AGENT_PROMPT_VERSION,
    toolRoundCount,
  });
  const record = getInvestigation(database, projectId, investigationId);
  if (!record) throw new InvestigationFailure("investigation_unavailable", "The terminal investigation record could not be loaded.");
  return record;
}

function failInvestigation(
  database: DatabaseSync,
  projectId: string,
  investigationId: string,
  toolRoundCount: number,
  failure: FailureDetails,
): InvestigationRecord {
  transitionInvestigation(database, {
    id: investigationId,
    projectId,
    status: "failed",
    errorCode: failure.code,
    errorSummary: failure.summary,
    toolRoundCount,
  });
  const record = getInvestigation(database, projectId, investigationId);
  if (!record) throw new InvestigationFailure("investigation_unavailable", "The failed investigation record could not be loaded.");
  return record;
}

function failureDetails(error: unknown): FailureDetails {
  if (error instanceof InvestigationFailure) return { code: error.code, summary: error.summary };
  if (error instanceof AgentRunError) {
    if (error.code === "connection") return { code: "agent_unavailable", summary: "The local model could not be reached; the investigation stopped." };
    if (error.code === "invalid_output") return { code: "invalid_agent_output", summary: "The model did not return a valid evidence-grounded response." };
    return { code: "agent_failure", summary: "The local model failed before producing a valid response." };
  }
  return { code: "investigation_failure", summary: "A local investigation operation failed." };
}

function isInvalidAgentOutput(error: unknown): boolean {
  if (error instanceof AgentRunError) return error.code === "invalid_output";
  if (!(error instanceof Error)) return false;
  return error.name === "ZodError" || /invalid diagnosis|evidence that was not supplied|cannot propose a fix/i.test(error.message);
}

function isTerminal(status: InvestigationRecord["status"]): boolean {
  return status === "diagnosed"
    || status === "needs_input"
    || status === "awaiting_patch_approval"
    || status === "resolved"
    || status === "dismissed";
}
