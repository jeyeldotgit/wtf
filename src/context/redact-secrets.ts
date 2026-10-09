const REDACTED = '[REDACTED_SECRET]';

/**
 * Trailing window size in characters.
 * Must be large enough to hold the longest secret pattern we want to match.
 */
const WINDOW_SIZE = 256;

/**
 * Ordered list of redaction patterns.
 * Each pattern is applied globally to the text.
 * Order matters: more specific patterns should come first.
 */
const PATTERNS: { regex: RegExp; replacement: string | ((substring: string, ...args: any[]) => string) }[] = [
  // PEM private key blocks (multi-line)
  {
    regex: /-----BEGIN[\w\s]*PRIVATE KEY-----[\s\S]*?-----END[\w\s]*PRIVATE KEY-----/g,
    replacement: REDACTED,
  },
  // Credential URLs: https://user:pass@host
  {
    regex: /https?:\/\/[^:\s@]+:[^@\s]+@[^\s]+/g,
    replacement: REDACTED,
  },
  // Bearer tokens
  {
    regex: /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/gi,
    replacement: REDACTED,
  },
  // Well-known API key prefixes: sk-*, ghp_*, xoxb-*, xoxp-*, AKIA*
  {
    regex: /\b(?:sk-[a-zA-Z0-9\-_]{20,}|ghp_[a-zA-Z0-9]{36,}|xoxb-[a-zA-Z0-9\-]{20,}|xoxp-[a-zA-Z0-9\-]{20,}|AKIA[A-Z0-9]{16})\b/g,
    replacement: REDACTED,
  },
  // AWS secret key assignments
  {
    regex: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|AWS_SECRET)\s*[:=]\s*\S{20,}/gi,
    replacement: (match: string) => {
      const sep = match.match(/[:=]/);
      if (sep) {
        const idx = match.indexOf(sep[0]);
        return match.slice(0, idx + 1) + ' ' + REDACTED;
      }
      return REDACTED;
    },
  },
  // Quoted secret assignments: token: "...", secret: '...', password = "..."
  {
    regex: /(?:token|secret|password|passwd|api_key|apikey|access_key|private_key|client_secret)\s*[:=]\s*["'][^"']{4,}["']/gi,
    replacement: (match: string) => {
      const sepMatch = match.match(/[:=]/);
      if (sepMatch) {
        const idx = match.indexOf(sepMatch[0]);
        return match.slice(0, idx + 1) + ' ' + REDACTED;
      }
      return REDACTED;
    },
  },
  // Unquoted env-style assignments: API_KEY=value (value is non-whitespace, 8+ chars)
  {
    regex: /\b[A-Z_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)\s*=\s*\S{8,}/g,
    replacement: (match: string) => {
      const eqIdx = match.indexOf('=');
      return match.slice(0, eqIdx + 1) + REDACTED;
    },
  },
];

/**
 * Apply all redaction patterns to a complete string.
 */
function applyPatterns(text: string): string {
  let result = text;
  for (const { regex, replacement } of PATTERNS) {
    // Reset lastIndex for global regexes
    regex.lastIndex = 0;
    if (typeof replacement === 'string') {
      result = result.replace(regex, replacement);
    } else {
      result = result.replace(regex, replacement as (substring: string, ...args: any[]) => string);
    }
  }
  return result;
}

/**
 * Stateful, stream-capable secret redactor.
 *
 * Buffers a trailing window of characters so that secrets split across
 * chunk boundaries are still detected and redacted.
 *
 * Usage:
 *   const r = new SecretRedactor();
 *   for (const chunk of chunks) {
 *     const safe = r.feed(chunk);
 *     output.write(safe);
 *   }
 *   output.write(r.flush());
 */
export class SecretRedactor {
  private buffer: string = '';
  private readonly windowSize: number;

  constructor(windowSize: number = WINDOW_SIZE) {
    this.windowSize = windowSize;
  }

  /**
   * Feed a chunk of text into the redactor.
   * Returns the redacted safe-to-emit prefix (may be empty if
   * insufficient data has accumulated).
   */
  feed(chunk: string): string {
    this.buffer += chunk;

    if (this.buffer.length <= this.windowSize) {
      // Not enough data to safely emit — a secret could span the boundary.
      return '';
    }

    const safePrefix = this.buffer.slice(0, -this.windowSize);
    this.buffer = this.buffer.slice(-this.windowSize);

    return applyPatterns(safePrefix);
  }

  /**
   * Flush the remaining buffer at end-of-stream.
   * Returns the final redacted text.
   */
  flush(): string {
    const remaining = this.buffer;
    this.buffer = '';
    return applyPatterns(remaining);
  }
}

/**
 * Convenience one-shot redactor for already-buffered strings.
 */
export function redactSecrets(text: string): string {
  const r = new SecretRedactor();
  const out = r.feed(text);
  return out + r.flush();
}
