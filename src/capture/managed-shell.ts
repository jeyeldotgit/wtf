import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Readable } from 'node:stream';
import type { CapturedRun } from './types.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { constants } from 'node:os';

type OutputStream = 'stdout' | 'stderr';
type OutputHandler = (stream: OutputStream, chunk: Buffer, runId?: string) => void;

type StreamCapture = {
  chunks: Buffer[];
  pending: Buffer;
  marker: Buffer;
  ended: boolean;
};

type ActiveRun = {
  runId: string;
  token: string;
  commandText: string;
  startTime: number;
  cwd: string;
  stdout: StreamCapture;
  stderr: StreamCapture;
  controlPending: Buffer;
  controlComplete: boolean;
  exitStatus: number | null;
  cwdAfter: string | null;
  resolve: (run: CapturedRun) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  maxOutputBytes: number;
  outputBytes: number;
  limited: boolean;
  cancelled: boolean;
};

export interface ManagedShellOptions {
  shell?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onOutput?: OutputHandler;
  onCommandStart?: (runId: string, commandText: string, startTime: number, cwd: string) => void;
  onExit?: (code: number | null, signal: string | null, limited?: boolean) => void;
}

const CONTROL_PREFIX = Buffer.from('\x1eWTF_CONTROL\0');

export class ManagedShell {
  private readonly shellPath: string;
  private currentCwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly onOutput: OutputHandler;
  private readonly onCommandStart?: ManagedShellOptions['onCommandStart'];
  private readonly onExit?: ManagedShellOptions['onExit'];
  private child: ChildProcess | undefined;
  private control: Readable | undefined;
  private active: ActiveRun | undefined;
  private ended = false;
  private restartable = false;

  constructor(options?: ManagedShellOptions) {
    // Resolve shell: options.shell > $SHELL env var > '/bin/sh' fallback
    const requestedShell = options?.shell ?? (process.platform === 'win32' ? '/bin/sh' : process.env.SHELL ?? '/bin/sh');
    this.shellPath = process.platform === 'win32' && requestedShell === '/bin/sh' && !existsSync(requestedShell)
      ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'sh.exe') : requestedShell;
    this.currentCwd = options?.cwd ?? process.cwd();
    this.env = { ...process.env, ...options?.env };
    if (process.platform === 'win32') {
      const pathKeys = Object.keys(this.env).filter(key => key.toLowerCase() === 'path');
      const inheritedPath = pathKeys.map(key => this.env[key]).filter(Boolean).join(';');
      for (const key of pathKeys) delete this.env[key];
      this.env.PATH = `${dirname(this.shellPath)};${inheritedPath}`;
    }
    this.onOutput = options?.onOutput ?? ((stream, chunk) => {
      (stream === 'stdout' ? process.stdout : process.stderr).write(chunk);
    });
    this.onCommandStart = options?.onCommandStart;
    this.onExit = options?.onExit;
  }

  /**
   * Execute a command and return a fully populated CapturedRun.
   * Streams output live to the user's terminal while capturing separately.
   */
  get cwd(): string { return this.currentCwd; }

  async execute(commandText: string, limits: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<CapturedRun> {
    if (this.active) throw new Error('A managed-shell command is already running');
    if (commandText.includes('\0')) throw new Error('Commands cannot contain null bytes');
    const child = this.ensureStarted();
    const token = randomUUID().replaceAll('-', '');
    const stdoutMarker = Buffer.from(`\x1eWTF_STDOUT_${token}\x1f`);
    const stderrMarker = Buffer.from(`\x1eWTF_STDERR_${token}\x1f`);
    const startTime = Date.now();
    const runId = randomUUID();

    return new Promise<CapturedRun>((resolve, reject) => {
      const active: ActiveRun = {
        runId,
        token,
        commandText,
        startTime,
        cwd: this.currentCwd,
        stdout: { chunks: [], pending: Buffer.alloc(0), marker: stdoutMarker, ended: false },
        stderr: { chunks: [], pending: Buffer.alloc(0), marker: stderrMarker, ended: false },
        controlPending: Buffer.alloc(0),
        controlComplete: false,
        exitStatus: null,
        cwdAfter: null,
        resolve,
        reject,
        maxOutputBytes: limits.maxOutputBytes ?? Infinity,
        outputBytes: 0,
        limited: false,
        cancelled: false,
      };
      this.active = active;
      if (limits.timeoutMs) active.timer = setTimeout(() => this.stopLimited(active), limits.timeoutMs);
      this.onCommandStart?.(runId, commandText, startTime, active.cwd);
      const script = this.commandScript(commandText, token);
      child.stdin!.write(script, (error) => {
        if (error) this.failActive(error);
      });
    });
  }

  destroy(): void {
    const child = this.child;
    if (!child) return;
    if (this.active && !this.active.limited) this.active.cancelled = true;
    if (process.platform !== 'win32') child.stdin?.end();
    if (process.platform !== 'win32' && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM');
        return;
      } catch {
        child.kill('SIGTERM');
        return;
      }
    }
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => child.kill('SIGTERM'));
      killer.on('close', code => { if (code !== 0) child.kill('SIGTERM'); });
      const active = this.active;
      const shutdown = setTimeout(() => {
        if (this.child !== child) return;
        child.kill('SIGKILL');
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        this.control?.destroy();
        this.child = undefined;
        this.control = undefined;
        this.ended = true;
        if (active && this.active === active) this.finishActive(active, null, 'SIGTERM');
        this.onExit?.(null, 'SIGTERM', active?.limited ?? false);
      }, 750);
      child.once('close', () => clearTimeout(shutdown));
      shutdown.unref();
    } else child.kill('SIGTERM');
  }

  private ensureStarted(): ChildProcess {
    if (this.ended && this.restartable) { this.ended = false; this.restartable = false; }
    if (this.ended) throw new Error('The managed-shell session has ended');
    if (this.child) return this.child;

    const child = spawn(this.shellPath, ['-s'], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: this.env,
      cwd: this.currentCwd,
      windowsHide: true,
    });
    const control = child.stdio[3] as Readable | null;
    if (!child.stdin || !child.stdout || !child.stderr || !control) {
      child.kill('SIGTERM');
      throw new Error('The shell did not provide all required capture streams');
    }

    this.child = child;
    this.control = control;
    child.stdout.on('data', (chunk: Buffer) => { if (this.child === child) this.consumeOutput('stdout', chunk); });
    child.stderr.on('data', (chunk: Buffer) => { if (this.child === child) this.consumeOutput('stderr', chunk); });
    control.on('data', (chunk: Buffer) => { if (this.child === child) this.consumeControl(chunk); });
    child.stdout.on('end', () => { if (this.child === child) this.endStream('stdout'); });
    child.stderr.on('end', () => { if (this.child === child) this.endStream('stderr'); });
    child.stdin.on('error', () => {}); // write callbacks report errors to the pending command
    child.on('error', (error) => { if (this.child === child) this.failActive(error); });
    child.on('close', (code, signal) => { if (this.child === child) this.handleClose(code, signal); });
    return child;
  }

  private commandScript(commandText: string, token: string): string {
    const statusVariable = `__wtf_status_${token}`;
    return [
      `if eval ${shellQuote(commandText)} 3>&- </dev/null; then`,
      `  ${statusVariable}=0`,
      'else',
      `  ${statusVariable}=$?`,
      'fi',
      `printf '\\036WTF_STDOUT_${token}\\037'`,
      `printf '\\036WTF_STDERR_${token}\\037' >&2`,
      // Windows does not inherit Node's extra pipe as POSIX descriptor 3.
      // After the stderr end marker, its remaining bytes are the private control frame.
      `printf '\\036WTF_CONTROL\\0%s\\0%s\\0%s\\0' '${token}' "$${statusVariable}" ${process.platform === 'win32' ? '"$(cygpath -aw "$PWD")"' : '"$PWD"'} >&${process.platform === 'win32' ? '2' : '3'}`,
      '',
    ].join('\n');
  }

  private consumeOutput(stream: OutputStream, chunk: Buffer): void {
    const active = this.active;
    if (!active) {
      this.onOutput(stream, chunk);
      return;
    }
    const state = active[stream];
    if (state.ended) {
      if (process.platform === 'win32' && stream === 'stderr') this.consumeControl(chunk);
      else this.onOutput(stream, chunk, active.runId);
      return;
    }

    const combined = Buffer.concat([state.pending, chunk]);
    const markerIndex = combined.indexOf(state.marker);
    if (markerIndex >= 0) {
      this.capture(active, stream, combined.subarray(0, markerIndex));
      state.pending = Buffer.alloc(0);
      state.ended = true;
      const trailing = combined.subarray(markerIndex + state.marker.length);
      if (trailing.length > 0) {
        if (process.platform === 'win32' && stream === 'stderr') this.consumeControl(trailing);
        else this.onOutput(stream, trailing, active.runId);
      }
    } else {
      const safeLength = Math.max(0, combined.length - state.marker.length + 1);
      if (safeLength > 0) this.capture(active, stream, combined.subarray(0, safeLength));
      state.pending = combined.subarray(safeLength);
    }
    this.completeIfReady(active);
  }

  private consumeControl(chunk: Buffer): void {
    const active = this.active;
    if (!active) return;
    let combined = Buffer.concat([active.controlPending, chunk]);

    while (combined.length > 0) {
      const markerIndex = combined.indexOf(CONTROL_PREFIX);
      if (markerIndex < 0) {
        const keep = Math.min(combined.length, CONTROL_PREFIX.length - 1);
        active.controlPending = combined.subarray(combined.length - keep);
        return;
      }
      combined = combined.subarray(markerIndex);
      let offset = CONTROL_PREFIX.length;
      const fields: Buffer[] = [];
      let incomplete = false;
      for (let index = 0; index < 3; index += 1) {
        const end = combined.indexOf(0, offset);
        if (end < 0) {
          incomplete = true;
          break;
        }
        fields.push(combined.subarray(offset, end));
        offset = end + 1;
      }
      if (incomplete) {
        active.controlPending = combined;
        return;
      }

      const [token, statusText, cwd] = fields.map((field) => field.toString('utf8'));
      active.controlPending = combined.subarray(offset);
      if (token !== active.token) continue;
      const status = Number(statusText);
      active.exitStatus = Number.isInteger(status) && status >= 0 && status <= 255 ? status : null;
      const nativeCwd = process.platform === 'win32' ? cwd.replace(/^\/([a-z])\//i, (_, drive: string) => `${drive.toUpperCase()}:/`).replaceAll('/', '\\') : cwd;
      active.cwdAfter = nativeCwd;
      if (nativeCwd) this.currentCwd = nativeCwd;
      active.controlComplete = true;
      this.completeIfReady(active);
      return;
    }
  }

  private capture(active: ActiveRun, stream: OutputStream, chunk: Buffer): void {
    if (chunk.length === 0) return;
    const retained = chunk.subarray(0, Math.max(0, active.maxOutputBytes - active.outputBytes));
    active.outputBytes += retained.length;
    if (retained.length) {
      active[stream].chunks.push(Buffer.from(retained));
      this.onOutput(stream, retained, active.runId);
    }
    if (retained.length < chunk.length && !active.limited) this.stopLimited(active);
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>(resolve => {
      child.once('close', () => { clearTimeout(force); resolve(); });
      const force = setTimeout(() => {
        child.kill('SIGKILL');
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        this.control?.destroy();
      }, 1500);
      this.destroy();
    });
  }

  private stopLimited(active: ActiveRun): void {
    if (this.active !== active || active.limited) return;
    active.limited = true;
    this.restartable = true;
    this.destroy();
    // A child ignoring SIGTERM must not hold the approval promise open.
    const child = this.child;
    const force = setTimeout(() => {
      if (process.platform !== 'win32' && child?.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      } else child?.kill('SIGKILL');
      if (this.active === active) {
        this.ended = true;
        this.child = undefined;
        this.control = undefined;
        this.finishActive(active, 124, 'SIGKILL');
      }
    }, 1000);
    force.unref();
  }

  private endStream(stream: OutputStream): void {
    const active = this.active;
    if (!active) return;
    const state = active[stream];
    this.flushPending(active, stream);
    state.ended = true;
    this.completeIfReady(active);
  }

  private flushPending(active: ActiveRun, stream: OutputStream): void {
    const state = active[stream];
    if (state.pending.length === 0) return;
    const keep = longestMarkerPrefixSuffix(state.pending, state.marker);
    this.capture(active, stream, state.pending.subarray(0, state.pending.length - keep));
    state.pending = Buffer.alloc(0);
  }

  private completeIfReady(active: ActiveRun): void {
    if (this.active !== active || !active.controlComplete || !active.stdout.ended || !active.stderr.ended) return;
    this.finishActive(active, active.exitStatus, null);
  }

  private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (process.platform === 'win32' && !signal && code && code > 255 && code <= 64 * 256 && code % 256 === 0) {
      signal = Object.entries(constants.signals).find(([, number]) => number === code / 256)?.[0] as NodeJS.Signals ?? null;
    }
    this.ended = true;
    this.child = undefined;
    this.control = undefined;
    const active = this.active;
    if (!active) {
      this.onExit?.(code, signal, this.restartable);
      return;
    }
    this.flushPending(active, 'stdout');
    this.flushPending(active, 'stderr');
    if (active.cancelled) signal ??= 'SIGTERM';
    const exitStatus = active.cancelled ? null : active.controlComplete ? active.exitStatus : signal === null ? code : null;
    this.finishActive(active, exitStatus, signal);
    this.onExit?.(code, signal, active.limited);
  }

  private failActive(error: Error): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    clearTimeout(active.timer);
    active.reject(error);
  }

  private finishActive(active: ActiveRun, exitStatus: number | null, signal: string | null): void {
    if (this.active !== active) return;
    this.active = undefined;
    clearTimeout(active.timer);
    active.resolve({
      runId: active.runId,
      commandText: active.commandText,
      stdout: Buffer.concat(active.stdout.chunks).toString('utf8'),
      stderr: Buffer.concat(active.stderr.chunks).toString('utf8'),
      exitStatus: active.limited ? 124 : exitStatus,
      signal,
      startTime: active.startTime,
      durationMs: Date.now() - active.startTime,
      localMetadata: { cwd: active.cwd, shell: this.shellPath },
      truncation: { stdoutTruncated: active.limited, stderrTruncated: active.limited },
    });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function longestMarkerPrefixSuffix(data: Buffer, marker: Buffer): number {
  const max = Math.min(data.length, marker.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (data.subarray(data.length - length).equals(marker.subarray(0, length))) return length;
  }
  return 0;
}
