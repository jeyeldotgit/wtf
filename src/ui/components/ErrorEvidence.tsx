import React from 'react';
import { Box, Text } from 'ink';
import { FailureEvidence } from '../types/index.js';

interface ErrorEvidenceProps {
  failure: FailureEvidence;
}

export const ErrorEvidence: React.FC<ErrorEvidenceProps> = ({ failure }) => {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={0}>
        <Text bold color="red">
          ✗ Command Failed:
        </Text>
        <Text color="yellow"> {failure.command}</Text>
        <Text dimColor> (exit code {failure.exitCode})</Text>
      </Box>

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="red"
        paddingX={1}
        marginTop={1}
      >
        <Box marginBottom={1}>
          <Text bold color="white">
            Diagnostic Summary:{' '}
          </Text>
          <Text color="red">{failure.errorSummary}</Text>
        </Box>

        <Box flexDirection="column">
          <Text dimColor bold>
            Captured Log Evidence:
          </Text>
          {failure.rawLogLines.map((line, idx) => (
            <Box key={idx}>
              <Text dimColor>{String(idx + 1).padStart(2, ' ')} │ </Text>
              <Text color="white">{line}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
};
