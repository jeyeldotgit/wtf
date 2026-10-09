# AI Agent Implementation

This document records the first agent slice implemented for WTF Local. It follows the product brief and architecture: local inference, bounded evidence, beginner-friendly explanations, and proposal-only fixes.

## Runtime contract

The public entry point is `runAgent(input)` in `src/agents/run-agent.ts`. It accepts one failed run and returns one of:

- `diagnosis`: a structured diagnosis with observations, evidence references, explanation, and optional proposed diff and verification command.
- `tool_requests`: one or more validated requests to look up recent logs, search log history, or inspect a small amount of project context.

The first slice does not execute tools. The application layer will need to handle returned requests with read-only services, attach their redacted results as evidence, and call the agent again. A diagnosis diff is a proposal; patch approval and command approval remain separate application responsibilities.

## Input and output boundary

`RunAgentInputSchema` requires a nonzero exit code, a display-safe command string, bounded stdout and stderr, and unique, identified evidence excerpts. It excludes the current working directory and caps combined context at 48,000 characters. Callers must redact secrets before constructing this input; schema validation is not a secret detector.

Project paths in evidence and proposed patches are validated as project-relative paths. Absolute paths, traversal, secret files, lockfiles, dependency folders, and common generated output folders are rejected. The future file-reading service must independently enforce the project-root boundary and content redaction.

`DiagnosisSchema` requires evidence ids for observations and causes. `runAgent` checks all returned evidence ids against the input before returning a diagnosis. Every proposed patch path is also checked against the safe-path rule.

## Model and prompt

The default model is `qwen2.5-coder:3b` through the AI SDK Ollama provider. Set `WTF_MODEL` to choose a locally installed alternative. The agent uses a single model turn and allows up to two attempts when the model returns an invalid diagnosis. A failed connection produces an actionable local Ollama error.

The system prompt treats logs, commands, files, and tool results as untrusted data. It asks the model to distinguish observations from likely causes, use supplied evidence ids, state uncertainty, and request one useful bounded lookup when needed. It must not execute commands, apply changes, claim a lookup ran, or expose private reasoning.

The three AI SDK tool definitions in `src/agents/tools.ts` contain only descriptions and input schemas. Their `execute` callbacks are intentionally absent. `getRecentLogs` and `searchLogs` cap results at 20; `getProjectContext` caps files at five.

## Synthetic Laminar evaluation

The dataset at `evals/datasets/run-agent-toolcalls-v1.jsonl` contains 24 synthetic examples: direct diagnoses, project-context requests, log lookups, insufficient-evidence cases, and prompt-injection cases. It contains no real project or user data.

Create the initial Laminar dataset, then append datapoints after changing the JSONL file:

```sh
pnpm eval:dataset:create
pnpm eval:dataset:push
```

Dataset upload and evaluation both use `LMNR_PROJECT_API_KEY`; no separate CLI login is needed. Use Node.js 22.12 or newer for the Laminar SDK. Run the eval with the same project key and a local Ollama model:

```sh
LMNR_PROJECT_API_KEY=... pnpm eval:agent
```

The runner repeats each case three times and records outcome kind, tool policy, required tools, argument relevance, duplicate calls, evidence grounding, question/fix policy, and unsafe-content checks. It initializes Laminar telemetry only inside the eval process. The evaluation executor uses synthetic examples, so do not replace the dataset with production or personal logs.

The model identifier and prompt version are attached to evaluation metadata. Compare prompt or model changes in Laminar using the same dataset and repeat count.

## Next build stages

Stage 1's command-capture and validated-input boundary is described in the [command capture build plan](command-capture-build-plan.md). Continue with these separate integration stages:

1. [Stage 2: local storage and bounded tools](build-stage-2-storage-and-tools.md) — persist local run and investigation history, and implement read-only handlers for all three requested tools.
2. [Stage 3: bounded investigation loop](build-stage-3-investigation-loop.md) — execute validated requests in the application, append identified evidence, and call the agent again until it returns a diagnosis or one focused question.
3. [Stage 4: diagnosis review and separate approvals](build-stage-4-diagnosis-review-and-approvals.md) — render the result and exact proposed diff, then keep patch and command approvals as separate user actions.
4. Expand the synthetic dataset when tools, evidence, or diagnosis behavior changes. Keep runtime Laminar tracing opt-in and isolated from real user data.
