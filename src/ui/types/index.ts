export type UIState = 
  | 'idle'
  | 'investigating'
  | 'diagnosis_ready'
  | 'patch_approved'
  | 'patch_rejected'
  | 'verifying'
  | 'verified_success'
  | 'verified_failure'
  | 'asking_question';

export interface FailureEvidence {
  command: string;
  exitCode: number;
  timestamp: string;
  cwd: string;
  rawLogLines: string[];
  errorSummary: string;
}

export interface FixPatch {
  filePath: string;
  description: string;
  conceptExplanation: string[];
  whyFixWorks: string;
  confidence: 'high' | 'medium' | 'low';
  diff: string;
}

export interface VerificationCommand {
  command: string;
  description: string;
}

export interface InvestigationData {
  state: UIState;
  failure: FailureEvidence;
  fix?: FixPatch;
  verification?: VerificationCommand;
  statusMessage?: string;
}
