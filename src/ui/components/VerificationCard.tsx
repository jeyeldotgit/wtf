import React from 'react';
import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';
import { UIState, VerificationCommand } from '../types/index.js';

interface VerificationCardProps {
  state: UIState;
  verification: VerificationCommand;
  outputSnippet?: string[];
}

export const VerificationCard: React.FC<VerificationCardProps> = ({
  state,
  verification,
  outputSnippet,
}) => {
  const getStatusBadge = () => {
    switch (state) {
      case 'verifying':
        return (
          <Box>
            <Spinner label="Running verification..." />
          </Box>
        );
      case 'verified_success':
        return <Text bold color="green">✔ PASSED</Text>;
      case 'verified_failure':
        return <Text bold color="red">✗ FAILED</Text>;
      default:
        return <Text dimColor>Awaiting Approval</Text>;
    }
  };

  const getBorderColor = () => {
    if (state === 'verified_success') return 'green';
    if (state === 'verified_failure') return 'red';
    if (state === 'verifying') return 'yellow';
    return 'gray';
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={getBorderColor()}
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Box>
          <Text bold color="magenta">
            🧪 Verification Step:
          </Text>
          <Text bold color="yellow"> {verification.command}</Text>
        </Box>
        <Box>{getStatusBadge()}</Box>
      </Box>

      <Box marginBottom={outputSnippet && outputSnippet.length > 0 ? 1 : 0}>
        <Text dimColor>{verification.description}</Text>
      </Box>

      {outputSnippet && outputSnippet.length > 0 && (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          {outputSnippet.map((line, idx) => (
            <Text key={idx} color={state === 'verified_success' ? 'green' : 'red'}>
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
};
