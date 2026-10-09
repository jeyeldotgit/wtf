import React from 'react';
import { Box, Text } from 'ink';
import type { RunAgentEvidence } from '../../agents/schemas.js';
import type { RunSummary } from '../adapters/investigation-view-model.js';

interface ErrorEvidenceProps {
  run: RunSummary;
  output: string;
  evidence: RunAgentEvidence[];
}

export const ErrorEvidence: React.FC<ErrorEvidenceProps> = ({ run, output, evidence }) => {
  const status = run.exitCode === null ? 'exit status unavailable' : `exit code ${run.exitCode}`;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color={run.status === 'failed' ? 'red' : 'green'}>
          {run.status === 'failed' ? 'Command failed:' : run.status === 'cancelled' ? 'Command interrupted:' : 'Command completed:'}
        </Text>
        <Text color="yellow"> {run.commandDisplay}</Text>
        <Text dimColor> ({status})</Text>
      </Box>

      {output && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
          <Text bold dimColor>Captured output</Text>
          <Text>{output}</Text>
        </Box>
      )}

      {evidence.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} marginTop={1}>
          <Text bold color="white">Evidence used for this diagnosis</Text>
          {evidence.map((item) => (
            <Box key={item.id} flexDirection="column" marginTop={1}>
              <Text dimColor>{item.id} · {item.sourceType}{item.relativePath ? ` · ${item.relativePath}` : ''}</Text>
              <Text color="white">{item.excerpt}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};
