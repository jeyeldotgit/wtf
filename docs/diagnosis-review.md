# Diagnosis review and approvals

Run the CLI from the project you want to diagnose using Node 22.5 or newer. During development, start it from this repository:

```powershell
node --import tsx src/run.ts
```

The managed shell uses a POSIX shell. On Windows it uses Git for Windows at `%ProgramFiles%\Git\usr\bin\sh.exe`; commands use Git Bash syntax. On other systems it uses `$SHELL` or `/bin/sh`. A TTY is required to answer questions and approve actions.

After a failed command, review the observations, cause, confidence, beginner explanation, and proposed diffs. Press **Ctrl+E** to expand or collapse the cited evidence excerpts. Complete captured streams are redacted and stripped of terminal controls before display; partial live output is withheld so split credentials cannot leak.

Use the arrow keys and Enter to choose **Apply** or **Decline**. Each patch preview is bound to the persisted proposal hash and the target file hashes taken when the diagnosis was saved. The service validates every file before writing. It supports exact unified diffs for up to three UTF-8 files, including creation and deletion in existing directories. It rejects unsafe paths, symlinks, hard links, secrets, hidden terminal controls, and patches requiring fuzzy context matching.

**Apply does not run verification.** After the patch decision, review the separate command card and choose **Run** or **Skip**. Run executes the exact approved command in the failed command's managed shell directory, with a 60-second limit and a combined 1 MB output limit. If a limit stops the shell, a later explicitly entered command starts a new shell in the same directory; shell-local environment changes are lost.

If a target changed after preview or after application, the review becomes `stale_patch`. Choose **Request a fresh diagnosis and preview**, review the new content, and approve again. Old proposal decisions remain in SQLite and cannot be replayed.

A diagnosis asking for missing information shows one question and hides all patch and command controls. Submitting an answer saves redacted evidence and resumes the bounded investigation. A failed verification saves its stdout, stderr, and exit status, attaches identified `run_log` evidence to the original investigation, and starts a new bounded investigation with the verification logs and previous diagnosis context.

The local database upgrades automatically to schema version 4. The Stage 4 suites cover separate approvals, keyboard controls, stale and tampered proposals, three-file patches, unsafe filesystem targets, terminal sanitization, failed verification, and execution limits:

```powershell
node --import tsx --test tests/stage4/approvals.test.ts tests/stage4/review-ui.test.tsx
```
