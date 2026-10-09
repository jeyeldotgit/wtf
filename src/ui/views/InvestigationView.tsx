import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import {
  CommandPrompt,
  ErrorEvidence,
  Header,
} from '../components/index.js';
import { DiagnosisReview } from '../components/DiagnosisReview.js';
import type { RunSession, RunSessionEvent } from '../../session/run-session.js';
import {
  buildInvestigationViewModel,
  buildRunSummary,
  sanitizeTerminalText,
  type InvestigationViewModel,
  type RunSummary,
} from '../adapters/investigation-view-model.js';
import type { UIState, PatchApprovalState, CommandApprovalState } from '../types/index.js';

const MAX_VISIBLE_OUTPUT_CHARACTERS = 24_000;

export interface InvestigationViewProps {
  session: RunSession;
  onExit?: () => void;
}

export const InvestigationView: React.FC<InvestigationViewProps> = ({ session, onExit }) => {
  const [state, setState] = useState<UIState>('shell_ready');
  const [activeCommand, setActiveCommand] = useState<string | null>(null);
  const [run, setRun] = useState<RunSummary | null>(null);
  const [viewModel, setViewModel] = useState<InvestigationViewModel | null>(null);
  const [output, setOutput] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [patchState, setPatchState] = useState<PatchApprovalState | null>(null);
  const [commandState, setCommandState] = useState<CommandApprovalState | null>(null);
  const [busy, setBusy] = useState(false);
  const operationActive = useRef(false);
  const approvedCommand = useRef(false);
  const activeReviewId = useRef<string | null>(null);
  const activeRunId = useRef<string | null>(null);
  const isInteractive = Boolean(process.stdin.isTTY);

  useEffect(() => session.subscribe(handleSessionEvent), [session]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') onExit?.();
  }, { isActive: isInteractive });

  const handleSessionEvent = (event: RunSessionEvent) => {
    switch (event.type) {
      case 'command_started':
        activeRunId.current = event.runId;
        setActiveCommand(event.commandDisplay);
        setRun(null);
        if (!approvedCommand.current) {
          setViewModel(null);
          setPatchState(null);
          setCommandState(null);
          activeReviewId.current = null;
        }
        setOutput('');
        setMessage(null);
        setState('running_command');
        break;
      case 'output':
        // Show complete redacted streams on completion: credentials and control
        // strings can span arbitrary live chunks, so raw partial text is hidden.
        break;
      case 'command_completed':
        setActiveCommand(null);
        setRun(buildRunSummary(event.run));
        setOutput(sanitizeTerminalText(`${event.captured.stdout}\n${event.captured.stderr}`, [session.projectRoot, event.run.cwd]).slice(-MAX_VISIBLE_OUTPUT_CHARACTERS));
        setState(event.run.status === 'failed' ? 'investigating' : 'shell_ready');
        break;
      case 'investigation_started':
        setState('investigating');
        break;
      case 'investigation_completed':
        try {
          const next = buildInvestigationViewModel(event.run, event.investigation, event.evidence, event.proposals);
          activeReviewId.current = next.investigationId;
          setRun(next.run);
          setViewModel(next);
          const patch = next.proposals.patch;
          const command = next.proposals.command;
          setPatchState(patch ? patch.status === 'proposed'
            ? { status: 'awaiting_patch_approval', proposalId: patch.id, diffs: next.diagnosis?.proposedFix?.files ?? [] }
            : patch.status === 'stale' ? { status: 'stale_patch', proposalId: patch.id, reason: patch.error ?? 'Request a fresh preview.' }
            : patch.status === 'applied' ? { status: 'patch_applied', proposalId: patch.id, appliedAt: patch.appliedAt! }
            : patch.error ? { status: 'patch_failed', proposalId: patch.id, error: patch.error }
            : { status: 'patch_declined', proposalId: patch.id } : null);
          setCommandState(command?.status === 'proposed' ? { status: 'awaiting_command_approval', proposalId: command.id,
            command: next.diagnosis?.verificationCommand?.command ?? '', reason: next.diagnosis?.verificationCommand?.reason ?? '' } : null);
          setState(stateForInvestigation(next.status));
          setMessage(next.errorSummary);
        } catch {
          setState('failed');
          setMessage('The stored diagnosis could not be safely displayed.');
        }
        break;
      case 'investigation_error':
      case 'session_error':
        setState('failed');
        setMessage(sanitizeTerminalText(event.message, [session.projectRoot]));
        break;
      case 'session_ended':
        setState('session_ended');
        onExit?.();
        break;
    }
  };

  const handleCommand = async (command: string) => {
    if (operationActive.current) return;
    setMessage(null);
    try {
      await session.execute(command);
    } catch {
      setState('failed');
      setMessage('The command session could not complete this request.');
    }
  };

  const perform = async (action: () => Promise<void>) => {
    if (operationActive.current) return;
    operationActive.current = true;
    setBusy(true);
    setMessage(null);
    try { await action(); }
    catch { setMessage('The action could not complete. Review the saved proposal and try a fresh diagnosis.'); }
    finally { operationActive.current = false; setBusy(false); }
  };

  const handlePatch = () => void perform(async () => {
    const patch = viewModel?.proposals.patch;
    if (!patch || patchState?.status !== 'awaiting_patch_approval') return;
    setPatchState({ status: 'applying_patch', proposalId: patch.id });
    try { setPatchState(await session.applyPatch(patch.id, patch.hash)); }
    catch { setPatchState({ status: 'patch_failed', proposalId: patch.id, error: 'The patch service could not complete. Request a fresh diagnosis.' }); }
  });

  const handleVerification = () => void perform(async () => {
    const command = viewModel?.proposals.command;
    if (!command || commandState?.status !== 'awaiting_command_approval') return;
    const reviewId = activeReviewId.current;
    approvedCommand.current = true;
    setCommandState({ status: 'running_command', proposalId: command.id });
    try {
      const result = await session.runCommand(command.id, command.hash);
      if (result.status === 'stale_patch') {
        setPatchState(result);
        setCommandState({ status: 'awaiting_command_approval', proposalId: command.id, command: command.command, reason: command.reason });
      } else if (activeReviewId.current === reviewId) setCommandState(result);
      else if (result.status === 'verification_failure') setMessage(`Verification exited with status ${result.exitCode}. A new diagnosis is shown below.`);
    } finally { approvedCommand.current = false; }
  });

  const handleDecline = (kind: 'patch' | 'command') => void perform(async () => {
    const proposal = kind === 'patch' ? viewModel?.proposals.patch : viewModel?.proposals.command;
    if (!proposal) return;
    session.decline(kind, proposal.id, proposal.hash);
    if (kind === 'patch') setPatchState({ status: 'patch_declined', proposalId: proposal.id });
    else setCommandState({ status: 'command_skipped', proposalId: proposal.id });
  });

  const diagnosis = viewModel?.diagnosis ?? null;
  const working = busy || state === 'running_command' || state === 'investigating';
  const needsInput = state === 'needs_input' || Boolean(diagnosis?.missingInformation.length);
  const patchPending = patchState?.status === 'awaiting_patch_approval' || patchState?.status === 'applying_patch';
  const reviewPending = !needsInput && (patchPending || patchState?.status === 'patch_failed' || patchState?.status === 'stale_patch'
    || commandState?.status === 'awaiting_command_approval' || commandState?.status === 'command_failed');

  return (
    <Box flexDirection="column" padding={1}>
      <Header state={state} />

      {run && <ErrorEvidence run={run} output={output} evidence={viewModel?.evidence ?? []} observations={diagnosis?.observations} />}
      {!run && (activeCommand || output) && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
          {activeCommand && <Text color="yellow">$ {activeCommand}</Text>}
          {output && <Text>{output}</Text>}
        </Box>
      )}

      {state === 'running_command' && <Spinner label="Command is running..." />}
      {state === 'investigating' && <Spinner label="Investigating the failed command..." />}
      {message && <Text color="red">{message}</Text>}

      {diagnosis && <DiagnosisReview diagnosis={diagnosis} needsInput={needsInput} patchState={patchState} commandState={commandState} disabled={working}
        onApply={handlePatch} onDecline={() => handleDecline('patch')} onRun={handleVerification} onSkip={() => handleDecline('command')}
        onRefresh={() => void perform(() => session.refreshDiagnosis(viewModel!.investigationId))}
        onAnswer={answer => void perform(() => session.refreshDiagnosis(viewModel!.investigationId, answer))} />}

      {state !== 'session_ended' && !needsInput && <CommandPrompt disabled={working || reviewPending || patchState?.status === 'stale_patch'} onSubmit={handleCommand} />}
    </Box>
  );
};

function stateForInvestigation(status: InvestigationViewModel['status']): UIState {
  switch (status) {
    case 'investigating':
      return 'investigating';
    case 'needs_input':
    case 'awaiting_user':
      return 'needs_input';
    case 'awaiting_patch_approval':
      return 'proposal_available';
    case 'failed':
      return 'failed';
    default:
      return 'diagnosed';
  }
}
