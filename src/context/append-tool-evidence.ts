import { createHash } from "node:crypto";
import {
  MAX_RUN_AGENT_EVIDENCE_COUNT,
  MAX_RUN_AGENT_EVIDENCE_EXCERPT_CHARS,
  MAX_RUN_AGENT_INPUT_CHARS,
  RunAgentEvidenceSchema,
  RunAgentInputSchema,
  type RunAgentEvidence,
  type RunAgentInput,
} from "../agents/schemas.js";

export const INITIAL_CONTEXT_CHAR_LIMIT = 32_000;
export const TOOL_ROUND_EXCERPT_CHAR_LIMIT = 8_000;
export const TOOL_EVIDENCE_CHAR_LIMIT = 16_000;
export const TOOL_EVIDENCE_ITEM_LIMIT = 18;
export const TOOL_EVIDENCE_ITEMS_PER_ROUND = 6;

const TOOL_RESULT_CHAR_LIMIT = 240;
const LIMITATION_NOTE = "Tool output was truncated/limited to preserve context budget.";

export type AppendToolEvidenceResult = {
  input: RunAgentInput;
  appendedEvidence: RunAgentEvidence[];
  limited: boolean;
  budgetExhausted: boolean;
};

export function runAgentInputCharacters(input: RunAgentInput): number {
  return input.commandDisplay.length
    + input.stdout.length
    + input.stderr.length
    + input.evidence.reduce((sum, item) => sum + item.excerpt.length, 0);
}

export function toolEvidenceBudgetExhausted(rawInput: RunAgentInput): boolean {
  const input = RunAgentInputSchema.parse(rawInput);
  const evidence = input.evidence.filter(isToolEvidence);
  const characters = evidence.reduce((sum, item) => sum + item.excerpt.length, 0);
  return runAgentInputCharacters(input) >= MAX_RUN_AGENT_INPUT_CHARS
    || characters >= TOOL_EVIDENCE_CHAR_LIMIT
    || evidence.length >= TOOL_EVIDENCE_ITEM_LIMIT
    || input.evidence.length >= MAX_RUN_AGENT_EVIDENCE_COUNT
    || MAX_RUN_AGENT_INPUT_CHARS - runAgentInputCharacters(input) < LIMITATION_NOTE.length;
}

export function capInitialRunAgentInput(rawInput: unknown): RunAgentInput {
  const input = RunAgentInputSchema.parse(rawInput);
  if (runAgentInputCharacters(input) <= INITIAL_CONTEXT_CHAR_LIMIT) return input;

  const commandDisplay = truncateText(input.commandDisplay, INITIAL_CONTEXT_CHAR_LIMIT);
  let remaining = INITIAL_CONTEXT_CHAR_LIMIT - commandDisplay.length;
  const evidence = input.evidence.map((item) => {
    const excerpt = truncateText(item.excerpt, remaining);
    remaining -= excerpt.length;
    return { ...item, excerpt };
  });
  const streamBudget = Math.max(0, remaining);
  let stderrBudget = Math.min(input.stderr.length, Math.ceil(streamBudget * 0.6));
  let stdoutBudget = Math.min(input.stdout.length, streamBudget - stderrBudget);
  let unused = streamBudget - stderrBudget - stdoutBudget;
  const moreStderr = Math.min(unused, input.stderr.length - stderrBudget);
  stderrBudget += moreStderr;
  unused -= moreStderr;
  stdoutBudget += Math.min(unused, input.stdout.length - stdoutBudget);

  return RunAgentInputSchema.parse({
    ...input,
    commandDisplay,
    stdout: truncateText(input.stdout, stdoutBudget),
    stderr: truncateText(input.stderr, stderrBudget),
    evidence,
  });
}

export function appendToolEvidence(currentInput: RunAgentInput, newEvidence: RunAgentEvidence[]): AppendToolEvidenceResult {
  const input = RunAgentInputSchema.parse(currentInput);
  const existingById = new Map(input.evidence.map((item) => [item.id, item]));
  const seen = new Map<string, RunAgentEvidence>();
  let limited = false;
  const candidates: RunAgentEvidence[] = [];

  for (const raw of newEvidence) {
    const excerpt = typeof raw?.excerpt === "string" ? raw.excerpt : "";
    if (excerpt.length > MAX_RUN_AGENT_EVIDENCE_EXCERPT_CHARS) limited = true;
    const parsed = RunAgentEvidenceSchema.parse({
      ...raw,
      excerpt: excerpt.slice(0, MAX_RUN_AGENT_EVIDENCE_EXCERPT_CHARS),
    });
    const prior = existingById.get(parsed.id) ?? seen.get(parsed.id);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(parsed)) throw new Error("Evidence id collision with different content");
      continue;
    }
    seen.set(parsed.id, parsed);
    candidates.push(parsed);
  }

  let selected = candidates.slice(0, TOOL_EVIDENCE_ITEMS_PER_ROUND);
  if (selected.length < candidates.length) limited = true;

  const currentToolEvidence = input.evidence.filter(isToolEvidence);
  const currentToolCharacters = currentToolEvidence.reduce((sum, item) => sum + item.excerpt.length, 0);
  const currentCharacters = runAgentInputCharacters(input);
  const itemRoom = Math.min(
    MAX_RUN_AGENT_EVIDENCE_COUNT - input.evidence.length,
    TOOL_EVIDENCE_ITEM_LIMIT - currentToolEvidence.length,
    TOOL_EVIDENCE_ITEMS_PER_ROUND,
  );
  const rawCharacters = selected.reduce((sum, item) => sum + item.excerpt.length, 0);
  const availableCharacters = Math.min(
    TOOL_ROUND_EXCERPT_CHAR_LIMIT,
    TOOL_EVIDENCE_CHAR_LIMIT - currentToolCharacters,
    MAX_RUN_AGENT_INPUT_CHARS - currentCharacters,
  );
  const hasOutcomeItem = selected.some((item) => item.sourceType === "tool_result");
  if (selected.length > itemRoom || rawCharacters > availableCharacters) limited = true;
  if (limited && !hasOutcomeItem && itemRoom < 1) throw new Error("No evidence slot remains for the tool-output limitation note");

  if (limited && hasOutcomeItem) {
    const outcome = selected.find((item) => item.sourceType === "tool_result")!;
    outcome.excerpt = appendLimitationNote(outcome.excerpt);
    selected = [outcome, ...selected.filter((item) => item.id !== outcome.id)];
  }

  const note = limited && !hasOutcomeItem
    ? RunAgentEvidenceSchema.parse({
      id: limitationEvidenceId(input, candidates),
      sourceType: "tool_result",
      excerpt: LIMITATION_NOTE,
    })
    : undefined;
  const noteCharacters = note?.excerpt.length ?? 0;
  const noteItems = note ? 1 : 0;
  let roundRemaining = TOOL_ROUND_EXCERPT_CHAR_LIMIT - noteCharacters;
  let toolRemaining = TOOL_EVIDENCE_CHAR_LIMIT - currentToolCharacters - noteCharacters;
  let contextRemaining = MAX_RUN_AGENT_INPUT_CHARS - currentCharacters - noteCharacters;
  let itemsRemaining = Math.max(0, itemRoom - noteItems);
  const appendedEvidence: RunAgentEvidence[] = [];

  for (const candidate of selected) {
    if (itemsRemaining <= 0) {
      limited = true;
      break;
    }
    const remaining = Math.min(roundRemaining, toolRemaining, contextRemaining, MAX_RUN_AGENT_EVIDENCE_EXCERPT_CHARS);
    if (remaining <= 0) {
      limited = true;
      break;
    }
    const excerpt = truncateText(candidate.excerpt, remaining);
    if (excerpt.length < candidate.excerpt.length) limited = true;
    const evidence = RunAgentEvidenceSchema.parse({ ...candidate, excerpt });
    appendedEvidence.push(evidence);
    roundRemaining -= excerpt.length;
    toolRemaining -= excerpt.length;
    contextRemaining -= excerpt.length;
    itemsRemaining -= 1;
  }

  if (note) {
    if (itemsRemaining < 0 || roundRemaining < 0 || toolRemaining < 0 || contextRemaining < 0) {
      throw new Error("No room remains for the required tool-output limitation evidence");
    }
    appendedEvidence.push(note);
    roundRemaining -= noteCharacters;
    toolRemaining -= noteCharacters;
    contextRemaining -= noteCharacters;
  }

  const result = RunAgentInputSchema.parse({
    ...input,
    evidence: [...input.evidence, ...appendedEvidence],
  });
  const toolEvidence = result.evidence.filter(isToolEvidence);
  const toolCharacters = toolEvidence.reduce((sum, item) => sum + item.excerpt.length, 0);
  const appendedCharacters = appendedEvidence.reduce((sum, item) => sum + item.excerpt.length, 0);
  const budgetExhausted = toolEvidenceBudgetExhausted(result);

  if (runAgentInputCharacters(result) > MAX_RUN_AGENT_INPUT_CHARS
    || toolCharacters > TOOL_EVIDENCE_CHAR_LIMIT
    || toolEvidence.length > TOOL_EVIDENCE_ITEM_LIMIT
    || appendedCharacters > TOOL_ROUND_EXCERPT_CHAR_LIMIT) {
    throw new Error("Appended tool evidence exceeded an investigation context budget");
  }

  return { input: result, appendedEvidence, limited, budgetExhausted };
}

function isToolEvidence(item: RunAgentEvidence): boolean {
  return item.sourceType !== "run_log" || item.id.startsWith("ev_");
}

function limitationEvidenceId(input: RunAgentInput, candidates: RunAgentEvidence[]): string {
  const source = [input.runId, ...input.evidence.map((item) => item.id), ...candidates.map((item) => item.id)].join("\0");
  return `ev_limit_${createHash("sha256").update(source).digest("hex").slice(0, 48)}`;
}

function appendLimitationNote(text: string): string {
  if (text.includes(LIMITATION_NOTE)) return text.slice(0, TOOL_RESULT_CHAR_LIMIT);
  const suffix = text.slice(0, Math.max(0, TOOL_RESULT_CHAR_LIMIT - LIMITATION_NOTE.length - 1));
  return `${LIMITATION_NOTE}${suffix ? ` ${suffix}` : ""}`.slice(0, TOOL_RESULT_CHAR_LIMIT);
}

function truncateText(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  const marker = "\n[…truncated…]\n";
  if (limit <= marker.length) return text.slice(0, limit);
  const contentLength = limit - marker.length;
  const headLength = Math.ceil(contentLength / 2);
  const tailLength = contentLength - headLength;
  return `${text.slice(0, headLength)}${marker}${tailLength ? text.slice(-tailLength) : ""}`;
}
