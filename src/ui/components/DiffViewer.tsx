import React from 'react';
import { Box, Text } from 'ink';
import type { Diagnosis } from '../../agents/schemas.js';

type ProposedFix = NonNullable<Diagnosis['proposedFix']>;

interface DiffViewerProps {
  proposedFix: ProposedFix;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ proposedFix }) => (
  <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} marginBottom={1}>
    <Text bold color="green">Read-only proposed fix</Text>
    <Text>{proposedFix.summary}</Text>
    <Text dimColor>Cites: {proposedFix.evidenceIds.join(', ')}</Text>

    {proposedFix.files.map((file) => {
      const lines = file.diff.split('\n');
      const additions = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
      const deletions = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
      return (
        <Box key={file.path} flexDirection="column" marginTop={1}>
          <Box justifyContent="space-between">
            <Text bold color="yellow">{file.path}</Text>
            <Text><Text color="green">+{additions} </Text><Text color="red">-{deletions}</Text></Text>
          </Box>
          <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
            {lines.map((line, index) => {
              const color = line.startsWith('+++') || line.startsWith('---')
                ? 'gray'
                : line.startsWith('@@')
                  ? 'cyan'
                  : line.startsWith('+')
                    ? 'green'
                    : line.startsWith('-')
                      ? 'red'
                      : undefined;
              return <Text key={`${index}-${line}`} color={color} dimColor={!color}>{line}</Text>;
            })}
          </Box>
        </Box>
      );
    })}
    <Text dimColor>This proposal is not applied in this diagnosis-only flow.</Text>
  </Box>
);
