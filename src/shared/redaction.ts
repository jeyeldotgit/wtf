const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/https?:\/\/[^:\s@]+:[^@\s]+@[^\s]+/gi, '[REDACTED_SECRET]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_SECRET]"],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED_SECRET]"],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[REDACTED_SECRET]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_SECRET]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_SECRET]"],
  [/\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\b(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*')/gi, '$1$2[REDACTED_SECRET]'],
  [/\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\b(\s*[:=]\s*)(["']?)[^\s"'`,;]+/gi, "$1$2[REDACTED_SECRET]"],
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

export function redactAbsolutePaths(value: string, localRoots: string[] = []): string {
  let result = value;
  const roots = [...localRoots].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const root of roots) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\\/]+/g, "[\\\\/]+");
    result = result.replace(new RegExp(escaped, "gi"), "[LOCAL_PATH]");
  }

  return result
    .replace(/\\\\[^\\\s]+\\[^\\\s]+(?:\\[^\\\s]*)*/g, "[LOCAL_PATH]")
    .replace(/\b[A-Z]:[\\/](?:[^\\/:*?"<>|\s]+[\\/]?)+/gi, "[LOCAL_PATH]")
    .replace(/(?<![\w:./-])\/(?:[^/\s]+\/)+[^/\s:]+/g, "[LOCAL_PATH]");
}

export function redactForStorageOrModel(value: string, localRoots: string[] = []): string {
  return redactAbsolutePaths(redactSecrets(value), localRoots);
}
