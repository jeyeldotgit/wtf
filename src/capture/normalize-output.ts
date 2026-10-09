import { PERSISTENCE_BYTE_LIMIT } from './types.js';
import type { CapturedRun } from './types.js';

/**
 * Truncate a single stream to fit within a byte budget.
 * Retains 50% head and 50% tail of the allowed budget, with
 * a truncation marker injected between them.
 *
 * Finds the nearest newline boundary within ±64 bytes to avoid
 * cutting mid-line.
 */
function truncateStream(
  content: string,
  budgetBytes: number,
  label: 'stdout' | 'stderr',
): { text: string; truncated: boolean } {
  const contentBytes = Buffer.byteLength(content, 'utf-8');
  if (contentBytes <= budgetBytes) {
    return { text: content, truncated: false };
  }

  // Reserve bytes for the marker text itself (estimate generously)
  const markerOverhead = 120; // e.g. "\n[... TRUNCATED stdout: retained 1234567 of 1234567 bytes ...]\n"
  const contentBudget = Math.max(0, budgetBytes - markerOverhead);
  const halfBudget = Math.floor(contentBudget / 2);

  // --- Head portion ---
  // Find the byte offset for the head, then snap to a newline boundary.
  let headEnd = findCharIndexForByteOffset(content, halfBudget);
  headEnd = snapToNewline(content, headEnd, 'backward');
  const head = content.slice(0, headEnd);

  // --- Tail portion ---
  const tailBudgetBytes = contentBudget - Buffer.byteLength(head, 'utf-8');
  // Work backwards from the end
  let tailStart = findCharIndexForByteOffsetFromEnd(content, tailBudgetBytes);
  tailStart = snapToNewline(content, tailStart, 'forward');
  const tail = content.slice(tailStart);

  const retainedBytes = Buffer.byteLength(head, 'utf-8') + Buffer.byteLength(tail, 'utf-8');
  const marker = `\n[... TRUNCATED ${label}: retained ${retainedBytes} of ${contentBytes} bytes ...]\n`;

  return { text: head + marker + tail, truncated: true };
}

/**
 * Find the character index in `text` such that
 * `Buffer.byteLength(text.slice(0, index))` is approximately `targetBytes`.
 */
function findCharIndexForByteOffset(text: string, targetBytes: number): number {
  // Binary search for efficiency
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(text.slice(0, mid), 'utf-8') <= targetBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/**
 * Like findCharIndexForByteOffset but counts bytes from the end of the string.
 * Returns the character index where the tail starts.
 */
function findCharIndexForByteOffsetFromEnd(text: string, targetBytes: number): number {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Buffer.byteLength(text.slice(mid), 'utf-8') <= targetBytes) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

/**
 * Snap a character index to the nearest newline boundary.
 * - 'backward': search backwards for a '\n' within 64 chars.
 * - 'forward': search forwards for a '\n' within 64 chars.
 * Falls back to the original index if no newline is found.
 */
function snapToNewline(
  text: string,
  index: number,
  direction: 'forward' | 'backward',
): number {
  const SNAP_RANGE = 64;

  if (direction === 'backward') {
    for (let i = index; i >= Math.max(0, index - SNAP_RANGE); i--) {
      if (text[i] === '\n') {
        return i + 1; // Include the newline in the head
      }
    }
  } else {
    for (let i = index; i < Math.min(text.length, index + SNAP_RANGE); i++) {
      if (text[i] === '\n') {
        return i + 1; // Start tail after the newline
      }
    }
  }

  return index;
}

/**
 * Normalize a CapturedRun by enforcing the 2 MB combined persistence limit.
 *
 * The budget is balanced between stdout and stderr so that a noisy stdout
 * cannot swallow stderr entirely:
 * - If only one stream exceeds half the budget, the other keeps its full
 *   content and the oversized stream gets the remainder.
 * - If both exceed half the budget, each gets exactly half.
 *
 * Returns a new CapturedRun with truncated streams and updated flags.
 */
export function normalizeOutput(run: CapturedRun): CapturedRun {
  const stdoutBytes = Buffer.byteLength(run.stdout, 'utf-8');
  const stderrBytes = Buffer.byteLength(run.stderr, 'utf-8');
  const totalBytes = stdoutBytes + stderrBytes;

  if (totalBytes <= PERSISTENCE_BYTE_LIMIT) {
    return {
      ...run,
      stdout: cleanText(run.stdout),
      stderr: cleanText(run.stderr),
      truncation: {
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    };
  }

  const halfBudget = Math.floor(PERSISTENCE_BYTE_LIMIT / 2);

  let stdoutBudget: number;
  let stderrBudget: number;

  if (stdoutBytes <= halfBudget) {
    // stdout fits in half — give stderr the remainder
    stdoutBudget = stdoutBytes;
    stderrBudget = PERSISTENCE_BYTE_LIMIT - stdoutBytes;
  } else if (stderrBytes <= halfBudget) {
    // stderr fits in half — give stdout the remainder
    stderrBudget = stderrBytes;
    stdoutBudget = PERSISTENCE_BYTE_LIMIT - stderrBytes;
  } else {
    // Both exceed half — split evenly
    stdoutBudget = halfBudget;
    stderrBudget = halfBudget;
  }

  const stdoutResult = truncateStream(run.stdout, stdoutBudget, 'stdout');
  const stderrResult = truncateStream(run.stderr, stderrBudget, 'stderr');

  // Also strip null bytes and normalize line endings
  return {
    ...run,
    stdout: cleanText(stdoutResult.text),
    stderr: cleanText(stderrResult.text),
    truncation: {
      stdoutTruncated: stdoutResult.truncated,
      stderrTruncated: stderrResult.truncated,
    },
  };
}

/**
 * Basic text cleanup: strip null bytes, normalize line endings.
 */
function cleanText(text: string): string {
  return text.replace(/\0/g, '').replace(/\r\n/g, '\n');
}
