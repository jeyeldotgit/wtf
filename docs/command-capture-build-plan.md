# Build plan: command capture and safe agent input

**Status:** Planned integration slice

## Objective

Capture each completed command in the WTF-managed shell, keep its stdout, stderr, and exit status, and preserve the command's normal terminal behavior. Save only redacted, bounded run data. Create a `RunAgentInput` and start an investigation only when the shell reports a nonzero exit status.

The flow follows the [product brief](product-brief.md) and [architecture](architecture.md). It ends at the validated input boundary for the existing [agent schema](../src/agents/schemas.ts).

## Scope

- Capture commands entered by the user in the managed shell, while output continues to appear in that shell.
- Record stdout and stderr as separate streams, the shell-reported exit status, start time, and duration. Keep any absolute working-directory metadata local to the application.
- Redact command text and output before retaining them or including them in model context.
- Store a bounded run record for successful and failed commands. Start an agent investigation only for a completed command with a known nonzero exit status.
- Construct and validate the `RunAgentInput` before calling `runAgent`.

Tool execution, project-file lookup, diagnosis rendering, and patch or command approvals are later integration slices.

## Data flow

1. **Start a run.** Assign a run ID and record start time and local shell metadata. Keep the raw command text out of application logs and telemetry.
2. **Capture while streaming.** Forward output to the user's terminal as it arrives. Capture stdout and stderr separately and track the shell's final exit status. Do not infer success or failure from text in the output.
3. **Redact.** Redact the command display and both streams before saving or building model context. Keep raw chunks only in transient process memory while redaction runs. Use a chunk-aware redactor so a credential split across output callbacks is still detected. Never write raw chunks to SQLite, debug logs, or telemetry.
4. **Bound retained output.** Apply the product's configurable 2 MB combined stdout/stderr limit per command, measured in UTF-8 bytes after redaction. When output exceeds the limit, retain a useful beginning and ending for each stream, include a truncation marker, and record which stream was truncated. Keep the marker inside the configured limit.
5. **Persist the sanitized run.** Store the bounded, redacted command display, streams, exit status, timing, and local-only metadata. Preserve the command's status and captured run if the agent or Ollama is unavailable.
6. **Gate investigation.** If the exit status is zero, finish after recording the run. If it is nonzero, build a bounded input from the sanitized record. If the shell cannot provide an exit status, record that capture outcome and do not invent a status for the agent.
7. **Validate and hand off.** Call `RunAgentInputSchema.parse()` on the explicitly mapped input. Call `runAgent()` only after parsing succeeds. Do not spread the stored run object into the input; that keeps working-directory paths and other local metadata out of model context.

## RunAgentInput budget

The input builder must stay aligned with the current schema limits:

| Field | Current limit |
| --- | ---: |
| `runId` | 100 characters |
| `commandDisplay` | 1,000 characters |
| `exitCode` | Integer from 1 through 255 |
| `stdout` | 16,000 characters |
| `stderr` | 16,000 characters |
| Each evidence excerpt | 4,000 characters |
| Evidence entries | 1–30 |
| Combined command, streams, and evidence | 48,000 characters |

For this first capture slice, use at most one `run_log` evidence excerpt for stdout and one for stderr. Select useful, redacted excerpts when a stream is longer than 4,000 characters. With the field limits above, command text, both streams, and two excerpts total at most 41,000 characters, leaving 7,000 characters for future context. Keep all truncation markers inside their field limits. Validate the aggregate limit in the schema rather than relying only on the individual caps.

Evidence IDs must be unique within the input, stable for a run and stream, and no longer than the schema's 80-character limit. Omit `relativePath` for `run_log` evidence. Since the schema requires at least one evidence entry, a failed command with empty stdout and stderr should receive one deterministic `run_log` excerpt stating its exit status and that both streams were empty.

If tool-result or project-file evidence is added later, its size must come out of the same 48,000-character budget.

## Implementation sequence

### 1. Prove managed-shell capture

Build a small capture spike before adding agent orchestration. Confirm that the chosen shell integration:

- Preserves the interactive shell's working directory and environment between commands.
- Keeps stdout and stderr separate and forwards both visibly.
- Reports the command's final exit status without changing what the next prompt observes.
- Works for the supported macOS and Linux shells.

A plain PTY can merge stdout and stderr, so verify stream separation in the actual adapter before committing to that approach. Preserve signal information locally when available. Use a shell-reported nonzero status for signaled commands; if no usable status is available, save the capture result and skip `RunAgentInput` creation.

### 2. Define the capture contract

Add a completed-run type under `src/capture/types.ts` with the run ID, command text, separate stdout/stderr, exit status, timestamps or duration, and local-only shell metadata. Represent an unavailable exit status explicitly so the input builder cannot mistake it for success or failure.

Keep capture mechanics in `src/capture/managed-shell.ts`. Keep output cleanup and bounded retention in `src/capture/normalize-output.ts`. The live shell path should display output independently from the buffers retained for storage and diagnosis.

### 3. Add redaction and bounded retention

Add `src/context/redact-secrets.ts` with recognizers for common secret assignments, bearer credentials, credential-bearing URLs, and common token formats. Replace detected values with a consistent marker. Maintain synthetic fixtures for values split across chunks. Redaction is best-effort, as stated in the product brief.

Apply the configurable combined byte limit to redacted output before it reaches storage. Add explicit truncation metadata so later history views and the agent can distinguish complete output from a shortened capture. Do not let one noisy stream silently erase all retained context from the other stream.

### 4. Add the failure gate and input builder

Add `src/context/build-run-agent-input.ts`. It should:

- Return no agent input for exit status zero or an unavailable status.
- Redact and bound `commandDisplay`, stdout, and stderr before assigning them to the schema fields.
- Create only `run_log` evidence from redacted captured output, with stable unique IDs.
- Add deterministic empty-output evidence for a failed command that produced no text.
- Omit working-directory metadata and all fields the schema does not accept.
- Parse the finished object with `RunAgentInputSchema` and return the parsed value.

Wire the shell/application orchestration to persist the sanitized run first, then pass only a validated failed-run input to `runAgent`. An Ollama connection error must leave the recorded run and original shell exit status intact.

### 5. Verify the slice

Check these behaviors before moving on to tool implementations:

- A zero exit status is captured and stored; it causes no `runAgent` call.
- A nonzero exit status produces one schema-valid input and one investigation handoff.
- Stdout and stderr remain separate, visible, and correctly associated with the run.
- Secrets in the command display and either output stream are redacted before persistence and agent input, including secrets split across chunks.
- Oversized output stays within the configured 2 MB retained-output cap and the schema's per-field and aggregate limits, with clear truncation markers.
- Empty-output failures still have valid evidence; every evidence ID is unique and within the schema limit.
- The serialized input contains no absolute working-directory path.
- A missing Ollama service does not alter command output, exit status, or saved run history.
- Signal termination and unavailable exit status behavior is recorded and documented by the shell adapter.

## Risks and decisions to resolve during the spike

- **Shell integration:** Separate stream capture and persistent interactive-shell state must both work on the target shells. The spike should settle the adapter approach.
- **Redaction coverage:** Pattern-based redaction cannot recognize every secret. Add recognizers from real-world formats only through synthetic fixtures; never use user logs as fixtures.
- **Truncation policy:** The capture and context limits serve different purposes. Storage keeps up to the configured combined byte cap; `RunAgentInput` is reduced further to the schema's character limits and selected evidence excerpts.
- **Schema drift:** If input limits change, update the builder and this plan together. Keep `RunAgentInputSchema.parse()` as the final boundary check.
