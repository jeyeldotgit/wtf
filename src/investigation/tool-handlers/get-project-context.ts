import { open, realpath, readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { GetProjectContextInputSchema, isSafeProjectRelativePath } from "../../agents/schemas.js";
import { redactForStorageOrModel } from "../../shared/redaction.js";
import { buildBoundedResult, createContentEvidence, emptyToolResult, type BoundedHandlerResult } from "./evidence.js";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_READ_BYTES = 256 * 1024;
const MAX_DIRECTORY_ENTRIES = 3_000;
const MAX_DEPTH = 10;
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".md", ".mdx", ".txt",
  ".html", ".css", ".scss", ".less", ".sql", ".prisma", ".go", ".rs", ".py", ".java", ".kt", ".c", ".h", ".hpp",
  ".cpp", ".cs", ".php", ".sh", ".ps1", ".bat", ".xml", ".ini", ".cfg", ".conf", ".gradle", ".properties", ".vue",
  ".svelte", ".astro", ".graphql", ".gql", ".tf", ".dockerignore", ".gitignore", ".editorconfig",
]);
const TEXT_BASENAMES = new Set(["makefile", "dockerfile", "readme", "license", "procfile"]);
const EXCLUDED_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg", "node_modules", "dist", "build", "coverage", ".next", ".turbo", ".cache", "target", "out"]);
const EXCLUDED_NAMES = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|(?:.*[-_.])?credentials(?:[-_.].*)?|(?:.*[-_.])?secrets?(?:[-_.].*)?|service-account\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.lock|poetry\.lock|pipfile\.lock|composer\.lock|gemfile\.lock|go\.sum)$/i;

type Candidate = { absolutePath: string; relativePath: string; score: number };
type WalkResult = { candidates: Candidate[]; scanned: number; capped: boolean };

export type ProjectContext = {
  database: DatabaseSync;
  projectId: string;
  activeRunId: string;
  investigationId: string;
  projectRoot: string;
};

export async function handleGetProjectContext(rawInput: unknown, context: ProjectContext): Promise<BoundedHandlerResult> {
  const input = GetProjectContextInputSchema.parse(rawInput);
  const query = input.query.trim();
  if (isUnsafePathQuery(query)) {
    return emptyToolResult(context.investigationId, "getProjectContext", "unavailable", "file_skipped: absolute, traversal, or restricted paths cannot be read.");
  }

  let rootReal: string;
  try {
    rootReal = await realpath(context.projectRoot);
  } catch {
    return emptyToolResult(context.investigationId, "getProjectContext", "unavailable", "Project context is unavailable because the project root could not be resolved.");
  }

  const walk = await findCandidates(rootReal, query);
  const selected = walk.candidates.slice(0, Math.max(input.maxFiles * 4, input.maxFiles));
  const evidence = [];
  let bytesRead = 0;
  let hadSkipped = false;
  let hadTruncated = false;
  let skippedCount = 0;
  let truncatedCount = 0;

  for (const candidate of selected) {
    if (evidence.length >= input.maxFiles) break;
    const normalizedRelative = candidate.relativePath.split(sep).join("/");
    if (!isSafeProjectRelativePath(normalizedRelative)) {
      hadSkipped = true;
      skippedCount += 1;
      continue;
    }

    let fileReal: string;
    try {
      fileReal = await realpath(candidate.absolutePath);
      if (!isInsideRoot(rootReal, fileReal)) {
        hadSkipped = true;
        skippedCount += 1;
        continue;
      }
      const canonicalRelative = relative(rootReal, fileReal).split(sep).join("/");
      if (!isSafeProjectRelativePath(canonicalRelative) || !isTextCandidate(basename(canonicalRelative))) {
        hadSkipped = true;
        skippedCount += 1;
        continue;
      }
      const metadata = await stat(fileReal);
      if (!metadata.isFile()) {
        hadSkipped = true;
        skippedCount += 1;
        continue;
      }
    } catch {
      hadSkipped = true;
      skippedCount += 1;
      continue;
    }

    const remaining = MAX_TOTAL_READ_BYTES - bytesRead;
    if (remaining <= 0) {
      hadSkipped = true;
      skippedCount += 1;
      continue;
    }
    const cap = Math.min(MAX_FILE_BYTES, remaining);
    let buffer: Buffer;
    let truncated = false;
    let handle;
    try {
      handle = await open(fileReal, "r");
      const readBuffer = Buffer.alloc(cap + 1);
      const { bytesRead: actualBytes } = await handle.read(readBuffer, 0, readBuffer.length, 0);
      buffer = readBuffer.subarray(0, Math.min(actualBytes, cap));
      truncated = actualBytes > cap;
    } catch {
      hadSkipped = true;
      skippedCount += 1;
      continue;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    bytesRead += buffer.length;
    if (buffer.includes(0)) {
      hadSkipped = true;
      skippedCount += 1;
      continue;
    }
    let text = buffer.toString("utf8");
    if (text.includes("\uFFFD")) {
      hadSkipped = true;
      skippedCount += 1;
      continue;
    }
    text = redactForStorageOrModel(text, [rootReal, context.projectRoot]);
    const excerpt = selectRelevantExcerpt(text, query, 4_000);
    if (!excerpt) {
      hadSkipped = true;
      skippedCount += 1;
      continue;
    }
    if (truncated) {
      hadTruncated = true;
      truncatedCount += 1;
    }
    const relativePath = relative(rootReal, candidate.absolutePath).split(sep).join("/");
    try {
      await assertStillInsideRoot(rootReal, candidate.absolutePath, fileReal);
      evidence.push(createContentEvidence({
        investigationId: context.investigationId,
        sourceKey: `project:${relativePath}`,
        sourceType: "project_file",
        relativePath,
        excerpt,
        localRoots: [rootReal, context.projectRoot],
      }));
    } catch {
      hadSkipped = true;
      skippedCount += 1;
    }
  }

  if (evidence.length === 0) {
    if (walk.capped) {
      return buildBoundedResult({
        investigationId: context.investigationId,
        toolName: "getProjectContext",
        contentEvidence: [],
        toolResult: "Project scan reached its deterministic directory-entry limit before finding a readable file.",
        outcomeStatus: "limited",
        safeSummary: "Project context scan was limited.",
      });
    }
    const reason = skippedCount > 0
      ? "file_skipped: matching files were outside the project, restricted, unreadable, or binary."
      : "No relevant project files were found for the query.";
    return emptyToolResult(context.investigationId, "getProjectContext", skippedCount > 0 ? "unavailable" : "empty", reason);
  }

  const toolResult = hadSkipped || hadTruncated
    ? `Some files were skipped (${skippedCount}) or truncated (${truncatedCount}) by path and size limits.`
    : walk.capped
      ? "Project scan reached its deterministic directory-entry limit."
      : undefined;
  return buildBoundedResult({
    investigationId: context.investigationId,
    toolName: "getProjectContext",
    contentEvidence: evidence,
    toolResult,
    outcomeStatus: hadSkipped || hadTruncated || walk.capped ? "limited" : "ok",
    safeSummary: `Read ${evidence.length} relevant project file(s) within configured limits.`,
  });
}

function isUnsafePathQuery(query: string): boolean {
  if (isAbsolute(query) || /(?:^|\s)(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(query)) return true;
  const pathLike = query.replaceAll("\\", "/");
  if (pathLike.split("/").some((part) => part === "..")) return true;
  const trimmed = basename(pathLike);
  return /^\.env(?:\..*)?$/i.test(trimmed) || /^(?:\.git|node_modules)$/i.test(trimmed);
}

async function findCandidates(root: string, query: string): Promise<WalkResult> {
  const terms = query.toLowerCase().match(/[a-z0-9_.-]{2,}/g) ?? [];
  const candidates: Candidate[] = [];
  let scanned = 0;
  let capped = false;

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || scanned >= MAX_DIRECTORY_ENTRIES) {
      capped = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++scanned > MAX_DIRECTORY_ENTRIES) {
        capped = true;
        return;
      }
      if (entry.name === "." || entry.name === "..") continue;
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath);
      const segments = relativePath.split(sep);
      if (segments.some((segment) => EXCLUDED_DIRS.has(segment.toLowerCase()) || EXCLUDED_NAMES.test(segment))) continue;
      if (entry.isDirectory()) {
        await walk(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!isTextCandidate(entry.name)) continue;
      candidates.push({
        absolutePath,
        relativePath,
        score: scoreCandidate(relativePath, query, terms),
      });
    }
  }

  await walk(root, 0);
  candidates.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));
  return { candidates, scanned, capped };
}

function isTextCandidate(name: string): boolean {
  const lower = name.toLowerCase();
  if (EXCLUDED_NAMES.test(lower)) return false;
  return TEXT_EXTENSIONS.has(extname(lower)) || TEXT_BASENAMES.has(lower);
}

function scoreCandidate(relativePath: string, query: string, terms: string[]): number {
  const lower = relativePath.toLowerCase();
  const file = basename(lower);
  let score = 0;
  for (const term of terms) {
    if (file.includes(term)) score += 14;
    else if (lower.includes(term)) score += 8;
  }
  if (/(^|\/)(src|source|app|lib|test|tests|config|configs)(\/|$)/.test(lower)) score += 2;
  if (/^(package\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+|next\.config\.[^/]+|readme(?:\.[^/]*)?)$/.test(file)) score += 1;
  if (query.toLowerCase().includes(lower)) score += 50;
  return score;
}

function selectRelevantExcerpt(text: string, query: string, maxCharacters: number): string {
  const lines = text.split(/\r?\n/);
  const terms = query.toLowerCase().match(/[a-z0-9_.-]{2,}/g) ?? [];
  const ranked = lines.map((line, index) => ({
    line,
    index,
    score: terms.reduce((score, term) => score + (line.toLowerCase().includes(term) ? 1 : 0), 0),
  }));
  const best = ranked.reduce((selected, current) => current.score > selected.score ? current : selected, { line: "", index: 0, score: -1 });
  const center = best.score > 0 ? best.index : 0;
  const start = Math.max(0, center - 20);
  let excerpt = lines.slice(start, start + 100).join("\n");
  if (excerpt.length > maxCharacters) excerpt = excerpt.slice(0, maxCharacters);
  return excerpt.trim();
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function assertStillInsideRoot(root: string, candidate: string, expectedRealPath: string): Promise<void> {
  const real = await realpath(candidate);
  if (!isInsideRoot(root, real) || real !== expectedRealPath) throw new Error("Candidate path changed or escaped project root");
}
