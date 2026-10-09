import React from 'react';
import { Box, Text } from 'ink';
import { UIState } from '../types/index.js';

interface ApprovalPromptProps {
  state: UIState;
}

export const ApprovalPrompt: React.FC<ApprovalPromptProps> = ({ state }) => {
  if (state !== 'proposal_available') return null;
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="single" borderColor="gray">
      <Text bold color="yellow">Approval is not enabled in this diagnosis-only flow.</Text>
      <Text dimColor>No files have been changed and no suggested command has been run.</Text>
    </Box>
  );
};
