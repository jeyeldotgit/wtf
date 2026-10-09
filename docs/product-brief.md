# WTF Local — Product Brief

**Status:** MVP definition v2.0  
**Product:** Local-first terminal debugging assistant  
**Name:** WTF Local

> When a local command fails, WTF explains the error, prepares a focused fix, and teaches why it should help—then waits for your approval before changing files.

## Product definition

WTF Local is a terminal-based assistant for beginners learning to build software. It observes commands run inside a WTF-managed terminal session. When a command exits unsuccessfully, WTF captures the output, inspects relevant project files, explains the likely cause, and prepares the smallest fix supported by the evidence.

WTF is focused on repairing an observed failure. It is not an open-ended coding agent: it does not build requested features, refactor unrelated code, or silently make changes. The user stays in control of every edit and every command started by the agent.

## Audience and first-release environment

The first release is for students and independent developers who are new to debugging Node.js and TypeScript projects. It supports macOS and Linux, with a locally installed Ollama model. Commands run by the user are captured inside a WTF-managed shell session.

## How a session works

1. **Start WTF:** `wtf` opens a managed shell in the current project. Commands the user enters run normally and their output remains visible.
2. **Detect a failure:** When a command exits with a nonzero status, WTF saves its redacted output and begins an investigation automatically. Successful commands do not trigger a diagnosis.
3. **Explain the failure:** WTF identifies the primary error, shows the log evidence, and describes the most likely cause and uncertainty in beginner-friendly language.
4. **Teach before proposing a change:** WTF gives a brief, step-by-step explanation of the concept behind the error and why the proposed fix addresses it. Progress messages may show what the assistant is doing, but it does not expose internal chain-of-thought.
5. **Preview the fix:** WTF prepares a focused patch and shows the exact diff. If the evidence is insufficient, it asks one targeted question instead of guessing.
6. **Ask before editing:** The user approves or rejects the exact patch. No project file changes before approval.
7. **Verify with separate approval:** To run a test or other command, WTF first shows the exact command and asks for approval. Its output is attached to the same investigation. If verification fails, WTF explains the new evidence and proposes another patch for approval; if it passes, WTF reports what was verified and what the user learned.

The user may ask follow-up questions about the active investigation with `wtf ask "..."`. They can review previous failures and proposed or approved fixes with `wtf history` and `wtf logs search`. `wtf doctor` checks local Ollama availability.

## Fix and access boundaries

- WTF may inspect relevant source, test, and configuration files inside the current project root. It skips `.env` files, credentials, private keys, `.git`, dependency directories such as `node_modules`, and generated build output.
- A proposed patch may change source files, tests, `package.json`, and ordinary project configuration. WTF does not directly edit lockfiles, generated files, or dependency directories.
- If a dependency repair needs a package-manager command, WTF presents the exact command and its effects. It runs it only after separate user approval.
- The agent may read captured output and bounded project context without sending them outside the machine. Model requests go only to local Ollama; there is no cloud fallback or product telemetry. User-entered commands and separately approved package-manager commands may themselves access the network.
- Secret redaction is best-effort. WTF treats logs and project files as untrusted data, not as instructions.
- Commands the user enters in the managed shell run as requested. Commands initiated by the agent require explicit approval for that exact command.

## What the MVP excludes

- Applying patches or running agent-proposed commands without approval.
- Open-ended code generation, unrelated refactors, and feature implementation.
- Automatic diagnosis of successful commands, always-on monitoring outside the WTF session, and arbitrary access to other terminal scrollback.
- Automatic investigation of full-screen TUI applications and long-running commands.
- Windows, IDE integration, remote or production logs, accounts, hosted services, and cloud inference.
- Repository-wide indexing, embeddings, and vector databases.
- Claims that every failure can be diagnosed or fixed automatically.

## Privacy and reliability

Run history is stored locally in SQLite, with a 14-day default retention period and a configurable 2 MB combined stdout/stderr limit per command. Only redacted output is stored. WTF does not include the absolute working-directory path in model context. Users can clear local history.

If Ollama is unavailable, WTF continues to capture failures and preserve history but cannot prepare an AI diagnosis or patch. Invalid or unsafe patches are rejected. If files change after a patch is previewed, WTF refreshes the preview and asks again before applying anything.

## How to evaluate the MVP

Evaluate 20–30 reproducible Node.js/TypeScript failures with beginners. Compare WTF with pasting the same error into a local model. Track:

- Whether the explanation and proposed fix are supported by captured evidence.
- Whether beginners understand what failed and why the patch addresses it.
- How often an approved patch passes the separately approved verification command.
- Time from failure to a verified fix, and the rate of speculative or rejected fixes.
- Whether any file edit or agent-started command occurs without its required approval.
- Whether model requests remain on the local endpoint.

Expand the product only if it helps beginners reach a verified fix and understand the change more reliably than a raw-error prompt, without making unapproved changes.
