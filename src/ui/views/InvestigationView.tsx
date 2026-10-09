import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import {
  ApprovalPrompt,
  CommandPrompt,
  DiffViewer,
  ErrorEvidence,
  Explanation,
  Header,
  QuestionModal,
  VerificationCard,
} from '../components/index.js';
import type { RunSession, RunSessionEvent } from '../../session/run-session.js';
import {
  buildInvestigationViewModel,
  buildRunSummary,
  sanitizeTerminalText,
  type InvestigationViewModel,
  type RunSummary,
} from '../adapters/investigation-view-model.js';
import type { UIState } from '../types/index.js';

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
        setViewModel(null);
        setOutput('');
        setMessage(null);
        setState('running_command');
        break;
      case 'output':
        if (activeRunId.current !== event.runId) break;
        setOutput((previous) => `${previous}${sanitizeTerminalText(event.text)}`.slice(-MAX_VISIBLE_OUTPUT_CHARACTERS));
        break;
      case 'command_completed':
        setActiveCommand(null);
        setRun(buildRunSummary(event.run));
        setState(event.run.status === 'failed' ? 'investigating' : 'shell_ready');
        break;
      case 'investigation_started':
        setState('investigating');
        break;
      case 'investigation_completed':
        try {
          const next = buildInvestigationViewModel(event.run, event.investigation, event.evidence);
          setRun(next.run);
          setViewModel(next);
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
        setMessage(event.message);
        break;
      case 'session_ended':
        setState('session_ended');
        onExit?.();
        break;
    }
  };

  const handleCommand = async (command: string) => {
    setMessage(null);
    try {
      await session.execute(command);
    } catch {
      setState('failed');
      setMessage('The command session could not complete this request.');
    }
  };

  const diagnosis = viewModel?.diagnosis ?? null;
  const working = state === 'running_command' || state === 'investigating';

  return (
    <Box flexDirection="column" padding={1}>
      <Header state={state} />

      {run && <ErrorEvidence run={run} output={output} evidence={viewModel?.evidence ?? []} />}
      {!run && (activeCommand || output) && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
          {activeCommand && <Text color="yellow">$ {activeCommand}</Text>}
          {output && <Text>{output}</Text>}
        </Box>
      )}

      {state === 'running_command' && <Spinner label="Command is running..." />}
      {state === 'investigating' && <Spinner label="Investigating the failed command..." />}
      {message && <Text color="red">{message}</Text>}

      {diagnosis && <Explanation diagnosis={diagnosis} />}
      {diagnosis?.proposedFix && <DiffViewer proposedFix={diagnosis.proposedFix} />}
      {diagnosis?.missingInformation[0] && <QuestionModal question={diagnosis.missingInformation[0]} />}
      {diagnosis?.verificationCommand && <VerificationCard verification={diagnosis.verificationCommand} />}
      {diagnosis?.proposedFix && <ApprovalPrompt state="proposal_available" />}

      {state !== 'session_ended' && <CommandPrompt disabled={working} onSubmit={handleCommand} />}
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
