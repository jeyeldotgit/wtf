# WTF Local

WTF Local is a local-first terminal debugging assistant. It runs commands in a managed shell, captures their output and exit status, and asks a local AI model to investigate failed commands. It may offer a diagnosis, a proposed patch, or a verification command. Patches and verification commands are shown for review and require your explicit approval; they are not applied or run automatically.

## Requirements

- Node.js 22.5 or newer. Node.js 22.12 or newer is recommended for the optional evaluation tooling.
- pnpm.
- Ollama and a locally available model for AI-backed diagnosis.
- An interactive terminal (TTY). Commands that require interactive stdin or a full-screen terminal, such as `vim` or `top`, are not supported inside WTF.

## Install dependencies

From the repository root:

```sh
pnpm install
```

## Set up Ollama

WTF uses `qwen2.5-coder:3b` by default. Make sure the Ollama service is running; if it is not managed by your system, start it in a separate terminal:

```sh
ollama serve
```

Then download the default model:

```sh
ollama pull qwen2.5-coder:3b
```

To use a different model already installed in Ollama, set `WTF_MODEL` before starting WTF:

```sh
export WTF_MODEL=<model-id>
```

Ollama is needed for AI diagnosis, but not for the automated test suite.

## Run from the repository

Start the interactive app in development mode:

```sh
pnpm dev
```

At the `$` prompt, enter one command at a time and press Enter. WTF runs commands from the directory where it was started. For example:

```sh
pwd
ls ./__wtf_missing_file__
```

The first command should succeed. The second intentionally fails and exercises the diagnosis flow; Ollama must be running for the AI response. The terminal UI redraws as you type, but the text should remain in the prompt until you press Enter.

The `dev` script runs the app directly to preserve interactive terminal input. Restart it manually after changing source files.

## Build and run

Compile the project and launch the built app:

```sh
pnpm build
pnpm start
```

## Install the `wtf` command globally

The package exposes a `wtf` executable that runs `dist/run.js`. From the repository root, build and link this private checkout into pnpm's global environment:

```sh
pnpm build
pnpm add --global .
```

Then run `wtf` from the root of the project you want to work in. The global command points to this checkout, so rebuild with `pnpm build` after changing source files.

If the command is not found, check pnpm's global binary directory:

```sh
pnpm bin --global
```

Ensure that directory is on your `PATH`. If pnpm has not configured its global path, run `pnpm setup` and restart your shell. In an existing zsh session, `rehash` refreshes command lookup.

## Tests and checks

Run the automated tests, typecheck, and build:

```sh
pnpm test
pnpm typecheck
pnpm build
```

`pnpm test:watch` watches the context tests under `src/context/__tests__`.

## Local data and optional evaluations

Run history is stored in SQLite at `~/.wtf/wtf.sqlite` by default. Set `WTF_DATABASE_PATH` to use a different database location.

The Laminar evaluation workflow is optional and requires `LMNR_PROJECT_API_KEY`; it is not needed to run WTF or its tests. Set the key in your environment rather than committing it, then run:

```sh
pnpm eval:agent
```
