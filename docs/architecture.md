# WTF Local --- Architecture

**Status:** Draft implementation architecture aligned to Product Brief v2.0\
**Architecture style:** Local-first CLI application with modular
components\
**Primary runtime:** Node.js + TypeScript\
**Inference:** Ollama local endpoint on loopback\
**Persistence:** SQLite\
**Principle:** The model reasons over evidence gathered by deterministic
tools; it does not own the operating system.

## 1. Goals and Non-Goals

### Goals

-   Capture command output and exit status in a WTF-managed shell session.
-   Keep logs, history, and model inference local by default.
-   Provide a small, testable tool interface for investigation.
-   Separate command capture, storage, retrieval, prompting, and model
    interaction.
-   Make diagnoses and proposed fixes traceable to concrete evidence.
-   Explain failures and fixes in a way that helps beginner developers
    learn.
-   Require approval for each patch and each command started by the agent.
-   Remain useful for capture and search when inference is unavailable.

### Non-goals

-   A general-purpose coding agent or open-ended feature builder.
-   Unapproved file modification or command execution.
-   Remote production log aggregation.
-   Multi-user hosted service.
-   Mandatory embeddings or vector database in the MVP.
-   Guaranteed root-cause identification.

## 2. High-Level Architecture

``` text
┌──────────────────────────────────────────────────────────────┐
│                         CLI Interface                        │
│  wtf managed shell | history | logs search | doctor          │
└──────────────────────────────┬───────────────────────────────┘
                               │
                 ┌─────────────▼─────────────┐
                 │       Application        │
                 │ commands + orchestration │
                 └──────┬───────────┬───────┘
                        │           │
          ┌─────────────▼───┐   ┌───▼────────────────┐
          │ Capture Service │   │ Investigation      │
          │ process output  │   │ Service            │
          └──────────┬──────┘   └───┬────────────────┘
                     │              │
             ┌───────▼──────────────▼────────┐
             │         Local Storage         │
             │ SQLite runs, events, findings │
             └────────────────┬─────────────┘
                              │
                   ┌──────────▼──────────┐
                   │ Context Builder      │
                   │ filter, redact, rank │
                   └──────────┬──────────┘
                              │
                   ┌──────────▼──────────┐
                   │ Agent / Model Layer │
                   │ diagnose + propose  │
                   └──────────┬──────────┘
                              │ proposal only
                   ┌──────────▼──────────┐
                   │ User approval gate  │
                   │ exact patch/command │
                   └──────┬────────┬────┘
                          │        │
                ┌─────────▼──┐  ┌──▼──────────────┐
                │ Patch      │  │ Approved-command│
                │ applier    │  │ runner          │
                └────────────┘  └─────────────────┘
```

The model endpoint is a local Ollama service. The application, not the
model, enforces approval before applying a patch or starting a command.

The diagram shows logical boundaries, not required deployment processes.
The CLI and model runtime run on the user's computer. SQLite is a local
file.

## 3. Suggested Technology Choices

  -----------------------------------------------------------------------
  Concern                 Initial choice          Reason
  ----------------------- ----------------------- -----------------------
  Language/runtime        Node.js + TypeScript    Strong CLI and process
                                                  APIs; familiar web
                                                  ecosystem

  CLI framework           Node.js built-ins       Keep the initial
                          first; optionally       dependency surface
                          Commander               small

  Agent orchestration     Vercel AI SDK           Typed tools and managed
                          `ToolLoopAgent` if      tool loop
                          supported by the        
                          selected                
                          SDK/provider/model      
                          combination             

  Model runtime           Ollama                  Local model management
                                                  and local HTTP API

  Model provider adapter  AI SDK compatible       Isolate provider
                          provider configured for details behind an
                          Ollama's                adapter
                          OpenAI-compatible       
                          endpoint, or a          
                          supported Ollama        
                          provider                

  Validation              Zod                     Validate inputs and
                                                  structured model output

  Persistence             SQLite with a           Local, embedded
                          TypeScript driver       persistence without a
                                                  server

  Tests                   Node test runner or     Unit and integration
                          Vitest                  tests

  Packaging               `pnpm` and TypeScript   Reproducible
                          build                   development and
                                                  distribution
  -----------------------------------------------------------------------

Pin versions and verify current provider compatibility before
implementation. Model support for tool calling and structured output
varies. Do not assume every Ollama model supports every agent feature.

## 4. Proposed Project Structure

``` text
wtf-local/
├── src/
│   ├── cli/
│   │   ├── index.ts
│   │   └── commands/
│   │       ├── shell.ts
│   │       ├── history.ts
│   │       ├── logs-search.ts
│   │       └── doctor.ts
│   ├── capture/
│   │   ├── managed-shell.ts
│   │   ├── normalize-output.ts
│   │   └── types.ts
│   ├── storage/
│   │   ├── database.ts
│   │   ├── schema.ts
│   │   └── repositories/
│   │       ├── runs.ts
│   │       ├── log-events.ts
│   │       └── investigations.ts
│   ├── context/
│   │   ├── build-context.ts
│   │   ├── redact-secrets.ts
│   │   └── project-context.ts
│   ├── investigation/
│   │   ├── agent.ts
│   │   ├── tools.ts
│   │   ├── prompts.ts
│   │   └── schemas.ts
│   ├── approvals/
│   │   ├── apply-approved-patch.ts
│   │   └── run-approved-command.ts
│   ├── model/
│   │   ├── provider.ts
│   │   └── health-check.ts
│   └── config/
│       ├── load-config.ts
│       └── defaults.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

Treat this as a proposed boundary map. Avoid creating every file before
its behavior is needed.

## 5. Main Workflows

### 5.1 Capture a managed terminal session

1.  User starts `wtf` in a project directory; WTF opens a managed shell
    session rooted there.
2.  Commands entered by the user run as requested. WTF streams their
    output normally and records stdout, stderr, exit status, timing, and
    local working-directory metadata.
3.  Values in command arguments and output are redacted before storage.
4.  Run records are stored locally. A nonzero exit automatically opens
    or updates an investigation; a successful exit does not trigger
    diagnosis.

The first release supports macOS and Linux. It captures completed
commands in the managed session; full-screen TUI applications and
long-running commands are not automatically investigated. Preserve the
user's exit status and document signal and process-tree limitations.

### 5.2 Diagnose and prepare a focused fix

1.  The application builds bounded context from the failed command,
    selected log excerpts, and relevant source, test, and configuration
    files under the project root.
2.  It excludes secrets, `.git`, dependency directories, and generated
    build output. The absolute working-directory path is not sent to the
    model.
3.  The model returns observations, a likely cause with evidence and
    uncertainty, a beginner-friendly explanation, and a minimal patch
    proposal.
4.  If the evidence does not support a safe patch, the agent asks one
    focused question instead of guessing.
5.  The application validates evidence references and allows patches
    only to source, test, `package.json`, and ordinary project
    configuration files inside the project root. It rejects secrets,
    lockfiles, dependencies, generated output, and paths outside the root.
6.  The CLI explains why the patch should help, then displays the exact
    diff and asks for approval.

### 5.3 Apply an approved patch and verify

1.  The application applies only the exact patch the user approved. If
    the target files changed after preview, it refreshes the diff and
    asks for approval again.
2.  To verify the result, the application displays the exact test or
    command and asks for separate approval before running it.
3.  Verification output is attached to the same investigation.
4.  On success, WTF explains what was fixed and what the check verified.
    On failure, it updates the evidence and proposes a new patch for
    approval; it never silently repeats a change or command.

Dependency and lockfile repairs are proposed as exact package-manager
commands, not direct edits. Each such command requires its own approval.

### 5.4 Ask a follow-up question

1.  User invokes `wtf ask "<question>"`.
2.  Application resolves the relevant run or investigation; ask for a
    run ID if ambiguous.
3.  Agent can call tools such as `getRecentLogs`, `searchLogs`, and
    `getProjectContext`.
4.  Tool outputs are bounded by size and access rules.
5.  Agent synthesizes an answer and distinguishes observations from
    hypotheses.
6.  Findings are appended to the investigation history.

### 5.5 Search previous logs

1.  User invokes `wtf logs search "<query>"`.
2.  Storage layer performs case-insensitive text search and filters by
    time, run, or project where requested.
3.  CLI prints matching snippets with timestamps and run IDs.
4.  No model call is needed for basic search.

## 6. Agent Design

### Agent responsibilities

-   Explain the primary failure in beginner-friendly language.
-   Compare log evidence with relevant, bounded project context.
-   Form a likely cause and describe uncertainty without claiming
    unverified facts.
-   Prepare the smallest supported patch, or ask one focused question if
    the evidence is insufficient.
-   Explain the concept behind the error and why the proposed patch
    should help before the user approves it.

### Tool contract

The model may call bounded read-only tools for run summaries, recent
logs, text search, related failures, and relevant project files. File
access is limited to the current project root; exclude credentials,
`.git`, dependency directories, and generated output.

The model can return a patch proposal but cannot write files or execute
commands. The application validates and displays the exact diff, then
applies it only after user approval. A separate application-level
command runner executes only the exact command the user approved. Neither
mutation capability is exposed as an autonomous model tool.

### Output schema concept

``` ts
type Diagnosis = {
  summary: string;
  observations: Array<{
    statement: string;
    evidenceIds: string[];
  }>;
  likelyCause?: {
    cause: string;
    rationale: string;
    evidenceIds: string[];
    confidence: "low" | "medium" | "high";
  };
  beginnerExplanation: string[];
  proposedFix?: {
    summary: string;
    evidenceIds: string[];
    files: Array<{ path: string; diff: string }>;
  };
  verificationCommand?: { command: string; reason: string };
  missingInformation: string[];
};
```

The application must verify evidence IDs and patch paths before showing a
proposal. A diagnosis is not considered verified because the model is
confident; verification requires a successful, user-approved check or a
user-reported result.

## 7. Data Model

A small relational schema is sufficient.

### `runs`

-   `id` --- unique identifier
-   `project_id` --- optional project identifier
-   `investigation_id` --- optional link for trigger and verification runs
-   `command_display` --- safely rendered command for display
-   `working_directory` --- local path, subject to privacy settings
-   `started_at`
-   `ended_at`
-   `exit_code` --- nullable if terminated before exit
-   `status` --- running, succeeded, failed, interrupted
-   `stdout_bytes`
-   `stderr_bytes`
-   `created_at`

### `log_events`

-   `id`
-   `run_id`
-   `stream` --- stdout or stderr
-   `sequence_number`
-   `timestamp` --- optional if source provides it
-   `content_redacted`
-   `severity` --- optional heuristic label
-   `content_hash` --- optional deduplication aid

### `investigations`

-   `id`
-   `trigger_run_id`
-   `status` --- investigating, awaiting approval, verifying, resolved,
    or needs input
-   `diagnosis_json`
-   `model_identifier`
-   `prompt_version`
-   `created_at`

### `fix_proposals`

-   `id`
-   `investigation_id`
-   `patch_json` --- exact proposed file changes
-   `status` --- proposed, declined, approved, or applied
-   `created_at`
-   `decided_at`

### `investigation_evidence`

-   `id`
-   `investigation_id`
-   `source_type`
-   `source_id`
-   `excerpt`
-   `content_hash`

Attach user-approved verification runs to their originating
investigation. Store redacted output only; raw-output retention is out of
scope for v0.1. Use a 14-day default history retention and a 2 MB
combined stdout/stderr limit per run, matching the product brief.

## 8. Context and Retrieval Strategy

Start with deterministic retrieval, not a vector database.

1.  Include sanitized command metadata, exit status, and timing. Do not
    include the absolute working-directory path in model context.
2.  Preserve the final output lines and relevant stderr.
3.  Detect likely error markers and include surrounding lines.
4.  Search for stack traces, exception names, error codes, and repeated
    messages.
5.  Cap total context size and each tool result.
6.  Provide stable evidence IDs so findings can refer to exact excerpts.
7.  Read relevant source, test, and configuration files only inside the
    project root; exclude secrets, `.git`, dependency directories, and
    generated output.
8.  Add semantic search only if evaluation shows keyword/time-based
    search is insufficient.

Do not send entire repositories or arbitrarily large logs to the model.
Context selection is a core product feature.

## 9. Privacy and Security

### Local-first guarantees

-   Model requests go only to a local Ollama endpoint on loopback.
-   No cloud inference or fallback in v0.1.
-   No product telemetry in v0.1.
-   Local database and logs are stored in a user-controlled data
    directory.
-   Document exactly what is stored and how to delete it.

### Threats and controls

-   **Secrets in logs:** Redact common API-key, token, password, and
    connection-string patterns in command arguments and output.
    Redaction is best-effort and cannot guarantee detection of every
    secret.
-   **Prompt injection in logs or files:** Treat retrieved text as
    untrusted evidence, never as system instructions. Tools enforce
    access rules independently of model output.
-   **Path traversal:** Resolve requested paths and ensure they remain
    inside approved project roots.
-   **Sensitive files:** Exclude `.env`, private keys, credential
    stores, and similar files by default.
-   **Command injection:** Never concatenate untrusted model output into
    a shell command. Show the exact agent-proposed command and run it
    only after separate user approval.
-   **Unbounded output:** Enforce byte, line, time, and context limits.
-   **Unapproved fixes:** The model can propose a patch but cannot write
    files. The application applies only the exact approved diff. Each
    agent-started command, including verification, requires separate
    approval.
-   **Local API exposure:** Bind model services to loopback where
    possible; do not expose the local endpoint to a network
    unnecessarily.

Local inference reduces external data transfer but does not, by itself,
guarantee privacy. The app, dependencies, and model runtime must also be
configured appropriately.

## 10. Error Handling and Degradation

-   If Ollama is unavailable, show a clear message with a health-check
    command; capture and search features remain usable.
-   If the model times out, retain the captured run and allow retry.
-   If output exceeds limits, explain which sections were truncated.
-   If the structured diagnosis or patch is invalid, do not apply it;
    retry once or return a clear failure.
-   If evidence is insufficient for a safe patch, ask one focused
    question instead of guessing.
-   If the user declines a patch, make no file changes and continue the
    managed shell session.
-   If a target file changes after patch preview, refresh the diff and
    require approval again.
-   If command capture is interrupted, persist available output and mark
    the run interrupted.

## 11. Configuration

Example conceptual configuration:

``` json
{
  "model": {
    "model": "YOUR_LOCAL_MODEL",
    "timeoutMs": 60000
  },
  "capture": {
    "maxOutputBytes": 2000000,
    "retainDays": 14
  },
  "privacy": {
    "excludeFiles": [
      ".env",
      ".env.*",
      "*.pem",
      "*.key"
    ]
  }
}
```

This is illustrative configuration, not a finalized schema. Validate
configuration at startup and avoid storing credentials in it.

## 12. Testing Strategy

### Unit tests

-   Output normalization and chunk boundaries.
-   Secret redaction patterns.
-   Context ranking and size limits.
-   Project-root and excluded-path enforcement for context and patches.
-   Diagnosis and patch-proposal validation.
-   Approval checks for patch application and command execution.
-   Search matching and evidence IDs.

### Integration tests

-   Managed-session stdout/stderr capture and exit-code preservation.
-   Automatic analysis on nonzero exit and no analysis on successful exit.
-   Interrupted process behavior.
-   SQLite persistence and retrieval.
-   Model unavailable, timeout, malformed patch, and rejected-patch cases.
-   Exact approved diff application and rejection of stale or out-of-root
    patches.
-   Separate approval before an agent-started verification or repair
    command, with its output attached to the investigation.
-   Ollama/provider tool-calling compatibility for the selected model.

### Evaluation set

Evaluate 20--30 reproducible Node.js/TypeScript failures with beginners.
Record the expected cause, evidence, minimal acceptable fix, and a
verification command. Compare against a raw-error prompt to a local
model.

Measure fix acceptance, verification pass rate, beginner understanding,
time to a verified fix, false-confidence rate, latency, and whether any
unapproved edit or command occurs. Keep the evaluation cases separate
from prompts.

## 13. Implementation Order

1.  **Capture:** Managed shell session, output capture, and exit-status
    preservation.
2.  **Persist:** Local run and investigation history, including linked
    verification runs.
3.  **Diagnose:** Bounded project context, local inference, evidence, and
    beginner-friendly explanation.
4.  **Fix safely:** Minimal patch proposals, diff preview, explicit
    patch approval, and separate command approval.
5.  **Verify and evaluate:** Attach approved verification output to the
    investigation and evaluate with beginners.
6.  **Harden:** Exclusions, retention, deletion, platform limitations,
    installation, and privacy documentation.

Do not start with embeddings, MCP, unapproved autonomous repairs, a
desktop GUI, or a background daemon. Add them only after the initial
workflow demonstrates measurable value.

## 14. Architecture Decision Records

### ADR-001: CLI before desktop

**Decision:** Start with a CLI.\
**Reason:** Lower implementation cost, easy testing, direct fit for
command failures.\
**Revisit when:** Users need persistent visual monitoring or
investigation browsing.

### ADR-002: Local model by default

**Decision:** Use a local model runtime with no automatic cloud
fallback.\
**Reason:** Privacy and offline-oriented positioning.\
**Trade-off:** Variable model quality and latency depending on hardware.

### ADR-003: Deterministic retrieval before embeddings

**Decision:** Use keyword, time, and error-pattern search first.\
**Reason:** Simpler, inspectable, and sufficient for a small initial
history.\
**Revisit when:** Evaluation demonstrates retrieval failures that
semantic search can address.

### ADR-004: Approval-gated fixes

**Decision:** The model may propose a focused patch but cannot write
files or execute commands. The application applies the exact patch only
after approval; each agent-started command requires separate approval.\
**Reason:** Let beginners get a direct fix while keeping every change
visible and under their control.

## 15. Open Technical Questions

-   Which managed-shell capture approach preserves ordinary terminal
    behavior on macOS and Linux?
-   Which Ollama model and response format produce useful, bounded patch
    proposals at acceptable latency on ordinary laptops?
-   How should process signals and child-process trees behave across the
    supported platforms?
-   How should output truncation preserve diagnostically useful sections
    within the configured per-run limit?
-   Which source and configuration files provide useful context without
    reading more of the project than needed?
-   Do the explanations help beginners understand and retain why an
    approved fix works?
