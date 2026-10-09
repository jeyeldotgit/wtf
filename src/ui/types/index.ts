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
