import React from 'react';
import type { Diagnosis } from '../../agents/schemas.js';
import type { CommandApprovalState, PatchApprovalState } from '../types/index.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { DiffViewer } from './DiffViewer.js';
import { Explanation } from './Explanation.js';
import { QuestionModal } from './QuestionModal.js';

export interface DiagnosisReviewProps {
  diagnosis: Diagnosis;
  needsInput: boolean;
  patchState: PatchApprovalState | null;
  commandState: CommandApprovalState | null;
  disabled: boolean;
  onApply: () => void;
  onDecline: () => void;
  onRun: () => void;
  onSkip: () => void;
  onRefresh: () => void;
  onAnswer: (answer: string) => void;
}

/** Question mode is a presentation boundary even for inconsistent stored diagnoses. */
export const DiagnosisReview: React.FC<DiagnosisReviewProps> = props => {
  const { diagnosis, patchState, commandState, disabled } = props;
  const needsInput = props.needsInput || diagnosis.missingInformation.length > 0;
  const patchPending = patchState?.status === 'awaiting_patch_approval' || patchState?.status === 'applying_patch';
  return <>
    <Explanation diagnosis={diagnosis} />
    {needsInput ? diagnosis.missingInformation[0] && <QuestionModal question={diagnosis.missingInformation[0]} disabled={disabled} onAnswer={props.onAnswer} /> : <>
      {diagnosis.proposedFix && <DiffViewer proposedFix={diagnosis.proposedFix} />}
      {patchState && <ApprovalPrompt kind="patch" state={patchState} disabled={disabled} onApprove={props.onApply} onDecline={props.onDecline} onRefresh={props.onRefresh} />}
      {commandState && <ApprovalPrompt kind="command" state={commandState} disabled={disabled || patchPending || patchState?.status === 'stale_patch' || patchState?.status === 'patch_failed'} onApprove={props.onRun} onDecline={props.onSkip} onRefresh={patchState?.status === 'patch_failed' || patchState?.status === 'stale_patch' ? undefined : props.onRefresh} />}
    </>}
  </>;
};
