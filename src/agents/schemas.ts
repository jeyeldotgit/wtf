import { z } from "zod";

const MAX_TEXT = 16_000;

export function isSafeProjectRelativePath(value: string): boolean {
  if (!value || value.length > 240 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\") || /^[a-zA-Z]:/.test(value)) return false;

  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (lowerParts.some((part) => [".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo", ".cache", "target", "out"].includes(part))) return false;
  if (parts.some((part) => /^\.env(?:\.|$)/i.test(part))) return false;
  if (parts.some((part) => [".ssh", ".aws", ".gnupg"].includes(part.toLowerCase()))) return false;
  if (parts.some((part) => /^(?:\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|credentials(?:\..+)?|service-account\.json)$/i.test(part))) return false;
  if (parts.some((part) => /\.(?:pem|key|p12|pfx|crt|cer|der|jks)$/i.test(part))) return false;
  if (parts.some((part) => /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json|cargo\.lock|poetry\.lock|pipfile\.lock|composer\.lock|gemfile\.lock|go\.sum)$/i.test(part))) return false;
  if (parts.some((part) => /\.(?:exe|dll|so|dylib|bin|class|jar|war|zip|gz|tgz|7z|rar|pdf|png|jpe?g|gif|ico|woff2?|ttf|otf|mp[34]|sqlite|db)$/i.test(part))) return false;
  return true;
}

const safeRelativePath = z.string().refine(isSafeProjectRelativePath, "must be a safe project-relative path");

export const RunAgentEvidenceSchema = z.object({
  id: z.string().trim().min(1).max(80),
  sourceType: z.enum(["run_log", "historical_log", "project_file", "tool_result"]),
  relativePath: safeRelativePath.optional(),
  excerpt: z.string().max(4_000),
}).strict().superRefine((evidence, context) => {
  if (evidence.sourceType === "project_file" && !evidence.relativePath) {
    context.addIssue({ code: "custom", path: ["relativePath"], message: "project file evidence requires a relative path" });
  }
  if (evidence.sourceType !== "project_file" && evidence.relativePath) {
    context.addIssue({ code: "custom", path: ["relativePath"], message: "log evidence cannot include a file path" });
  }
});

export const RunAgentInputSchema = z.object({
  runId: z.string().trim().min(1).max(100),
  commandDisplay: z.string().trim().min(1).max(1_000),
  exitCode: z.number().int().min(1).max(255),
  stdout: z.string().max(MAX_TEXT),
  stderr: z.string().max(MAX_TEXT),
  evidence: z.array(RunAgentEvidenceSchema).min(1).max(30),
}).strict().superRefine((input, context) => {
  const ids = new Set<string>();
  const totalCharacters = input.commandDisplay.length
    + input.stdout.length
    + input.stderr.length
    + input.evidence.reduce((sum, item) => sum + item.excerpt.length, 0);
  if (totalCharacters > 48_000) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "combined run context must be at most 48,000 characters" });
  }
  input.evidence.forEach((item, index) => {
    if (ids.has(item.id)) {
      context.addIssue({ code: "custom", path: ["evidence", index, "id"], message: "evidence ids must be unique" });
    }
    ids.add(item.id);
  });
});

export const GetRecentLogsInputSchema = z.object({
  runId: z.string().trim().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(20).default(5),
}).strict();

export const SearchLogsInputSchema = z.object({
  query: z.string().trim().min(1).max(256),
  runId: z.string().trim().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(20).default(5),
}).strict();

export const GetProjectContextInputSchema = z.object({
  query: z.string().trim().min(1).max(256),
  maxFiles: z.number().int().min(1).max(5).default(3),
}).strict();

export const DiagnosisSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  observations: z.array(z.object({
    statement: z.string().trim().min(1).max(1_000),
    evidenceIds: z.array(z.string().min(1)).min(1).max(10),
  }).strict()).min(1).max(8),
  likelyCause: z.object({
    cause: z.string().trim().min(1).max(500),
    rationale: z.string().trim().min(1).max(1_000),
    evidenceIds: z.array(z.string().min(1)).min(1).max(10),
    confidence: z.enum(["low", "medium", "high"]),
  }).strict().optional(),
  beginnerExplanation: z.array(z.string().trim().min(1).max(500)).min(1).max(6),
  proposedFix: z.object({
    summary: z.string().trim().min(1).max(500),
    evidenceIds: z.array(z.string().min(1)).min(1).max(10),
    files: z.array(z.object({
      path: safeRelativePath,
      diff: z.string().min(1).max(20_000),
    }).strict()).min(1).max(3),
  }).strict().optional(),
  verificationCommand: z.object({
    command: z.string().trim().min(1).max(500),
    reason: z.string().trim().min(1).max(500),
  }).strict().optional(),
  missingInformation: z.array(z.string().trim().min(1).max(500)).max(1),
}).strict();

export const ToolRequestSchema = z.discriminatedUnion("toolName", [
  z.object({ toolName: z.literal("getRecentLogs"), input: GetRecentLogsInputSchema }).strict(),
  z.object({ toolName: z.literal("searchLogs"), input: SearchLogsInputSchema }).strict(),
  z.object({ toolName: z.literal("getProjectContext"), input: GetProjectContextInputSchema }).strict(),
]);

export const RunAgentResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("diagnosis"), diagnosis: DiagnosisSchema }).strict(),
  z.object({ kind: z.literal("tool_requests"), requests: z.array(ToolRequestSchema).min(1).max(5) }).strict(),
]);

export type RunAgentInput = z.infer<typeof RunAgentInputSchema>;
export type RunAgentEvidence = z.infer<typeof RunAgentEvidenceSchema>;
export type Diagnosis = z.infer<typeof DiagnosisSchema>;
export type ToolRequest = z.infer<typeof ToolRequestSchema>;
export type RunAgentResult = z.infer<typeof RunAgentResultSchema>;

export function validateDiagnosisForInput(value: unknown, input: RunAgentInput): Diagnosis {
  const diagnosis = DiagnosisSchema.parse(value);
  if (diagnosis.missingInformation.length > 0 && diagnosis.proposedFix) {
    throw new Error("Diagnosis cannot propose a fix while requesting missing information");
  }
  const knownIds = new Set(input.evidence.map((item) => item.id));
  const referencedIds = [
    ...diagnosis.observations.flatMap((item) => item.evidenceIds),
    ...(diagnosis.likelyCause?.evidenceIds ?? []),
    ...(diagnosis.proposedFix?.evidenceIds ?? []),
  ];
  for (const id of referencedIds) {
    if (!knownIds.has(id)) throw new Error("Diagnosis references evidence that was not supplied to the agent");
  }
  return diagnosis;
}
