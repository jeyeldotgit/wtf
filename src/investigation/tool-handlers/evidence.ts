import { createHash } from "node:crypto";
import { RunAgentEvidenceSchema, type RunAgentEvidence } from "../../agents/schemas.js";
import { redactForStorageOrModel } from "../../shared/redaction.js";

export const MAX_TOOL_EXCERPT_CHARACTERS = 8_000;
export const MAX_TOOL_CONTENT_RECORDS = 5;
export const MAX_TOOL_RESULT_CHARACTERS = 240;
const MAX_EVIDENCE_EXCERPT = 4_000;

export type HandlerOutcome = "ok" | "empty" | "limited" | "unavailable" | "error";
export type BoundedHandlerResult = {
  evidence: RunAgentEvidence[];
  outcomeStatus: HandlerOutcome;
  safeSummary: string;
};

export function stableEvidenceId(investigationId: string, sourceKey: string): string {
  const digest = createHash("sha256").update(`${investigationId}\0${sourceKey}`).digest("hex");
  return `ev_${digest}`;
}

export function createContentEvidence(input: {
  investigationId: string;
  sourceKey: string;
  sourceType: "run_log" | "historical_log" | "project_file";
  excerpt: string;
  relativePath?: string;
  localRoots?: string[];
}): RunAgentEvidence {
  const excerpt = redactForStorageOrModel(input.excerpt, input.localRoots).slice(0, MAX_EVIDENCE_EXCERPT);
  const contentHash = createHash("sha256").update(excerpt).digest("hex");
  return RunAgentEvidenceSchema.parse({
    id: stableEvidenceId(input.investigationId, `${input.sourceKey}:${contentHash}`),
    sourceType: input.sourceType,
    relativePath: input.relativePath,
    excerpt,
  });
}

export function createToolResultEvidence(investigationId: string, sourceKey: string, summary: string): RunAgentEvidence {
  return RunAgentEvidenceSchema.parse({
    id: stableEvidenceId(investigationId, `tool_result:${sourceKey}`),
    sourceType: "tool_result",
    excerpt: redactForStorageOrModel(summary).slice(0, MAX_TOOL_RESULT_CHARACTERS),
  });
}

export function buildBoundedResult(input: {
  investigationId: string;
  toolName: string;
  contentEvidence: RunAgentEvidence[];
  toolResult?: string;
  outcomeStatus: HandlerOutcome;
  safeSummary: string;
  preferLastContent?: boolean;
}): BoundedHandlerResult {
  const evidence: RunAgentEvidence[] = [];
  let total = 0;
  let limited = input.outcomeStatus === "limited"
    || input.contentEvidence.length > MAX_TOOL_CONTENT_RECORDS
    || input.contentEvidence.reduce((sum, item) => sum + item.excerpt.length, 0) > MAX_TOOL_EXCERPT_CHARACTERS;
  const resultText = input.toolResult ?? (limited ? "Additional results were omitted by the response budget." : undefined);
  const resultBudget = resultText ? Math.min(MAX_TOOL_RESULT_CHARACTERS, resultText.length) : 0;
  const contentBudget = MAX_TOOL_EXCERPT_CHARACTERS - resultBudget;
  const candidates = input.preferLastContent ? [...input.contentEvidence].reverse() : input.contentEvidence;
  for (const item of candidates) {
    if (evidence.length >= MAX_TOOL_CONTENT_RECORDS) {
      limited = true;
      continue;
    }
    const remaining = contentBudget - total;
    if (remaining <= 0) {
      limited = true;
      continue;
    }
    const excerpt = item.excerpt.slice(0, Math.min(remaining, MAX_EVIDENCE_EXCERPT));
    if (excerpt.length < item.excerpt.length) limited = true;
    const bounded = RunAgentEvidenceSchema.parse({ ...item, excerpt });
    evidence.push(bounded);
    total += bounded.excerpt.length;
  }

  if (resultText) {
    evidence.push(createToolResultEvidence(input.investigationId, `${input.toolName}:${input.safeSummary}`, resultText));
  }
  if (input.preferLastContent) {
    const content = evidence.filter((item) => item.sourceType !== "tool_result").reverse();
    const result = evidence.filter((item) => item.sourceType === "tool_result");
    evidence.splice(0, evidence.length, ...content, ...result);
  }
  const outcomeStatus = limited ? "limited" : input.outcomeStatus;
  return {
    evidence,
    outcomeStatus,
    safeSummary: redactForStorageOrModel(input.safeSummary).slice(0, MAX_TOOL_RESULT_CHARACTERS),
  };
}

export function emptyToolResult(investigationId: string, toolName: string, status: "empty" | "unavailable" | "error", message: string): BoundedHandlerResult {
  const evidence = createToolResultEvidence(investigationId, `${toolName}:${status}:${message}`, message);
  return { evidence: [evidence], outcomeStatus: status, safeSummary: message.slice(0, MAX_TOOL_RESULT_CHARACTERS) };
}

export function centeredExcerpt(content: string, query: string, max = MAX_EVIDENCE_EXCERPT): string {
  if (content.length <= max) return content;
  const needle = query.trim().toLowerCase();
  const foundAt = needle ? content.toLowerCase().indexOf(needle) : 0;
  const start = Math.max(0, (foundAt < 0 ? 0 : foundAt) - Math.floor(max / 2));
  const end = Math.min(content.length, start + max);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`.slice(0, max);
}
