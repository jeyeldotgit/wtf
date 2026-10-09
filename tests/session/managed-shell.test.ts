import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ManagedShell } from "../../src/capture/managed-shell.js";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "wtf-managed-shell-"));
}

describe("persistent managed shell", () => {
  it("preserves cwd and environment while capturing separate streams and exit codes", async () => {
    const root = temporaryDirectory();
    const nested = join(root, "nested");
    mkdirSync(nested);
    const forwarded: Record<"stdout" | "stderr", string[]> = { stdout: [], stderr: [] };
    const shell = new ManagedShell({
      shell: "/bin/sh",
      cwd: root,
      env: { WTF_SESSION_TEST: "initial" },
      onOutput: (stream, chunk) => forwarded[stream].push(chunk.toString("utf8")),
    });

    try {
      const first = await shell.execute(`cd '${nested}' && export WTF_SESSION_TEST=preserved && printf 'out-marker\\n' && printf 'err-marker\\n' >&2`);
      assert.equal(first.exitStatus, 0);
      assert.equal(first.localMetadata.cwd, root);
      assert.match(first.stdout, /out-marker/);
      assert.match(first.stderr, /err-marker/);
      assert.doesNotMatch(first.stdout, /err-marker/);
      assert.doesNotMatch(first.stderr, /out-marker/);

      const second = await shell.execute(`printf '%s\\n' "$WTF_SESSION_TEST"; ${process.platform === 'win32' ? 'cygpath -aw .' : 'pwd'}`);
      assert.equal(second.exitStatus, 0);
      assert.equal(second.localMetadata.cwd, nested);
      assert.match(second.stdout, /preserved/);
      assert.equal(statSync(second.stdout.trim().split('\n').at(-1)!).ino, statSync(nested).ino);

      const failed = await shell.execute("false");
      assert.equal(failed.exitStatus, 1);
      const afterFailure = await shell.execute("printf 'alive\\n'");
      assert.equal(afterFailure.exitStatus, 0);
      assert.match(afterFailure.stdout, /alive/);
      assert.ok(forwarded.stdout.join("").includes("alive"));
      assert.ok(forwarded.stderr.join("").includes("err-marker"));
    } finally {
      await shell.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const shellPath of ["/bin/sh", "/bin/bash", "/bin/zsh"]) {
    if (!existsSync(shellPath)) continue;
    it(`preserves shell state with ${shellPath}`, async () => {
      const root = temporaryDirectory();
      const shell = new ManagedShell({ shell: shellPath, cwd: root, onOutput: () => undefined });
      try {
        const first = await shell.execute("export WTF_SHELL_TEST=preserved; cd \"$PWD\"; printf '%s\\n' first");
        const second = await shell.execute("printf '%s\\n' \"$WTF_SHELL_TEST\"; pwd");
        assert.equal(first.exitStatus, 0);
        assert.equal(second.exitStatus, 0);
        assert.match(second.stdout, /preserved/);
        assert.match(second.stdout, new RegExp(root.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
      } finally {
        shell.destroy();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("preserves user output that resembles control framing", async () => {
    const shell = new ManagedShell({ shell: "/bin/sh", onOutput: () => undefined });
    try {
      const run = await shell.execute("printf '\\036WTF_CONTROL\\000not-a-frame\\n'");
      assert.equal(run.exitStatus, 0);
      assert.match(run.stdout, /WTF_CONTROL/);
      assert.match(run.stdout, /not-a-frame/);
    } finally {
      shell.destroy();
    }
  });

  it("terminates the active command process group when the shell is destroyed", { timeout: 3000 }, async () => {
    let started: () => void = () => {};
    const commandStarted = new Promise<void>((resolve) => { started = resolve; });
    const shell = new ManagedShell({
      shell: "/bin/sh",
      onOutput: () => undefined,
      onCommandStart: () => started(),
    });
    try {
      const pending = shell.execute("sleep 20");
      await commandStarted;
      await new Promise((resolve) => setTimeout(resolve, 50));
      shell.destroy();
      const run = await pending;
      assert.equal(run.exitStatus, null);
      assert.equal(run.signal, "SIGTERM");
    } finally {
      shell.destroy();
    }
  });

  it("records a shell signal as an unavailable command status", async () => {
    const shell = new ManagedShell({ shell: "/bin/sh", onOutput: () => undefined });
    const run = await shell.execute("kill -TERM $$");
    assert.equal(run.exitStatus, null);
    assert.equal(run.signal, "SIGTERM");
  });
});
