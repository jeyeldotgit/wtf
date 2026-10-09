import { redactForStorageOrModel } from './redaction.js';

/** Untrusted terminal content is always plain, redacted text. Includes 8-bit CSI/OSC/DCS. */
export function sanitizeTerminalText(value: string, roots: string[] = []): string {
  const plain = value
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g, '')
    .replace(/(?:\u001b[P^_X]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/g, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*$/g, '')
    .replace(/\u001b[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\r\n?/g, '\n');
  return redactForStorageOrModel(plain, roots);
}

export function sanitizeDiffText(diff: string, roots: string[] = []): string {
  return diff.split('\n').map(line => line === '--- /dev/null' || line === '+++ /dev/null' ? line : sanitizeTerminalText(line, roots)).join('\n');
}
