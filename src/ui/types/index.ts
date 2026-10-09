export type UIState =
  | "shell_ready"
  | "running_command"
  | "investigating"
  | "diagnosed"
  | "needs_input"
  | "proposal_available"
  | "failed"
  | "session_ended";

export type { InvestigationViewModel, RunSummary } from "../adapters/investigation-view-model.js";

export type FileDiff = NonNullable<import('../../agents/schemas.js').Diagnosis['proposedFix']>['files'][number];
export type PatchApprovalState =
  | { status: 'awaiting_patch_approval'; proposalId: string; diffs: FileDiff[] }
  | { status: 'applying_patch'; proposalId: string }
  | { status: 'patch_applied'; proposalId: string; appliedAt: number }
  | { status: 'patch_declined'; proposalId: string }
  | { status: 'stale_patch'; proposalId: string; reason: string }
  | { status: 'patch_failed'; proposalId: string; error: string };
export type CommandApprovalState =
  | { status: 'awaiting_command_approval'; proposalId: string; command: string; reason: string }
  | { status: 'running_command'; proposalId: string }
  | { status: 'command_skipped'; proposalId: string }
  | { status: 'command_failed'; proposalId: string; error: string }
  | { status: 'verification_success'; exitCode: number; output: string }
  | { status: 'verification_failure'; exitCode: number; output: string };
