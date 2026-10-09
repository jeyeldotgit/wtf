import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { CapturedRun } from './types.js';

export class ManagedShell {
  private shellPath: string;

  constructor(options?: { shell?: string }) {
    // Resolve shell: options.shell > $SHELL env var > '/bin/sh' fallback
    this.shellPath = options?.shell ?? process.env.SHELL ?? '/bin/sh';
  }

  /**
   * Execute a command and return a fully populated CapturedRun.
   * Streams output live to the user's terminal while capturing separately.
   */
  async execute(commandText: string): Promise<CapturedRun> {
    const runId = randomUUID();
    const startTime = Date.now();
    const cwd = process.cwd();

    return new Promise<CapturedRun>((resolve, reject) => {
      const child = spawn(this.shellPath, ['-c', commandText], {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env },
        cwd,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      // Live-forward stdout to terminal AND accumulate
      child.stdout!.on('data', (chunk: Buffer) => {
        process.stdout.write(chunk);
        stdoutChunks.push(chunk);
      });

      // Live-forward stderr to terminal AND accumulate
      child.stderr!.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
        stderrChunks.push(chunk);
      });

      child.on('error', (err) => {
        reject(err);
      });

      child.on('close', (code: number | null, signal: string | null) => {
        const durationMs = Date.now() - startTime;
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');

        // If code is null and a signal was received, exitStatus is null (don't invent a code)
        let exitStatus: number | null;
        if (code !== null) {
          exitStatus = code;
        } else {
          exitStatus = null; // Signal kill or unknown
        }

        resolve({
          runId,
          commandText,
          stdout,
          stderr,
          exitStatus,
          startTime,
          durationMs,
          localMetadata: {
            cwd,
            shell: this.shellPath,
          },
          truncation: {
            stdoutTruncated: false,
            stderrTruncated: false,
          },
        });
      });
    });
  }

  /** Clean up any held resources. */
  destroy(): void {
    // No persistent resources in the current implementation.
    // Placeholder for future PTY-based or persistent-shell variants.
  }
}
