import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CommandApprovalState, PatchApprovalState } from '../types/index.js';
import { sanitizeTerminalText } from '../../shared/terminal-text.js';

interface ApprovalPromptProps {
  kind: 'patch' | 'command';
  state: PatchApprovalState | CommandApprovalState;
  disabled?: boolean;
  onApprove: () => void;
  onDecline: () => void;
  onRefresh?: () => void;
}

export const ApprovalPrompt: React.FC<ApprovalPromptProps> = ({ kind, state, disabled, onApprove, onDecline, onRefresh }) => {
  const awaiting = state.status === 'awaiting_patch_approval' || state.status === 'awaiting_command_approval';
  const interactive = Boolean(process.stdin.isTTY);
  const stale = state.status === 'stale_patch';
  const canRefresh = Boolean(onRefresh) && (stale || state.status === 'patch_failed' || state.status === 'command_failed');
  const [affirmative, setAffirmative] = useState(false);
  const submitted = useRef(false);
  const proposalKey = 'proposalId' in state ? state.proposalId : '';
  useLayoutEffect(() => { setAffirmative(false); submitted.current = false; }, [state.status, proposalKey]);
  useEffect(() => { if (!disabled) submitted.current = false; }, [disabled]);
  useInput((_input, key) => {
    if (key.downArrow || key.rightArrow) setAffirmative(true);
    if (key.upArrow || key.leftArrow) setAffirmative(false);
    if (key.return && !submitted.current) {
      if (canRefresh) { if (affirmative) { submitted.current = true; onRefresh?.(); } }
      else { submitted.current = true; if (affirmative) onApprove(); else onDecline(); }
    }
  }, { isActive: interactive && !disabled && (awaiting || canRefresh) });
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={kind === 'patch' ? 'green' : 'cyan'} paddingX={1} marginBottom={1}>
      <Text bold>{kind === 'patch' ? 'Approve file changes' : 'Approve verification command'}</Text>
      {state.status === 'awaiting_command_approval' && <>
        <Text color="yellow">$ {sanitizeTerminalText(state.command)}</Text>
        <Text>{sanitizeTerminalText(state.reason)}</Text>
        <Text dimColor>Runs in the failed command’s shell directory. Limit: 60 seconds and 1 MB of output.</Text>
      </>}
      {kind === 'patch' && awaiting && <Text>Apply changes to the files shown above.</Text>}
      {!awaiting && <Text color={stale || state.status.endsWith('failed') || state.status === 'verification_failure' ? 'yellow' : 'green'}>{state.status.replaceAll('_', ' ')}</Text>}
      {state.status === 'stale_patch' && <Text>{sanitizeTerminalText(state.reason)}</Text>}
      {'error' in state && <Text color="red">{sanitizeTerminalText(state.error)}</Text>}
      {'output' in state && <><Text>Exit status: {state.exitCode}</Text><Text>{sanitizeTerminalText(state.output).slice(-24000)}</Text></>}
      {awaiting && interactive && <Box flexDirection="column">
        <Text dimColor={disabled}>{!affirmative ? '> ' : '  '}{kind === 'patch' ? '[Decline]' : '[Skip]'}</Text>
        <Text dimColor={disabled}>{affirmative ? '> ' : '  '}{kind === 'patch' ? '[Apply]' : '[Run]'}</Text>
        <Text dimColor>{disabled ? 'Finish the active review above to enable these controls.' : 'Use arrow keys to choose, then Enter to confirm.'}</Text>
      </Box>}
      {awaiting && !interactive && <Text dimColor>A TTY is required to approve this proposal.</Text>}
      {canRefresh && interactive && <Box flexDirection="column">
        <Text dimColor={disabled}>{!affirmative ? '> ' : '  '}Keep reviewing</Text>
        <Text dimColor={disabled}>{affirmative ? '> ' : '  '}Request a fresh diagnosis and preview</Text>
        <Text dimColor>Use arrow keys to choose, then Enter to confirm.</Text>
      </Box>}
    </Box>
  );
};
