import React from 'react';
import { Box, Text } from 'ink';
import { Badge } from '@inkjs/ui';
import { UIState } from '../types/index.js';

interface HeaderProps {
  state: UIState;
}

export const Header: React.FC<HeaderProps> = ({ state }) => {
  const getBadge = () => {
    switch (state) {
      case 'idle':
        return <Badge color="gray">IDLE</Badge>;
      case 'investigating':
        return <Badge color="yellow">INVESTIGATING</Badge>;
      case 'diagnosis_ready':
        return <Badge color="cyan">PROPOSED FIX</Badge>;
      case 'patch_approved':
        return <Badge color="green">PATCH APPLIED</Badge>;
      case 'patch_rejected':
        return <Badge color="red">PATCH REJECTED</Badge>;
      case 'verifying':
        return <Badge color="yellow">VERIFYING</Badge>;
      case 'verified_success':
        return <Badge color="green">RESOLVED</Badge>;
      case 'verified_failure':
        return <Badge color="red">VERIFICATION FAILED</Badge>;
      case 'asking_question':
        return <Badge color="blue">QUESTION</Badge>;
      default:
        return <Badge color="gray">WTF</Badge>;
    }
  };

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between" alignItems="center">
        <Box>
          <Text bold color="magenta">
            ⚡ WTF
          </Text>
          <Text color="gray"> Local</Text>
          <Text dimColor> (v0.1.0-mvp)</Text>
        </Box>
        <Box>{getBadge()}</Box>
      </Box>
      <Box marginTop={0}>
        <Text dimColor>{"─".repeat(60)}</Text>
      </Box>
    </Box>
  );
};
