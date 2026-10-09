import React from 'react';
import { Box, Text } from 'ink';
import { FixPatch } from '../types/index.js';

interface DiffViewerProps {
  patch: FixPatch;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ patch }) => {
  const diffLines = patch.diff.split('\n');

  let additions = 0;
  let deletions = 0;

  diffLines.forEach(line => {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="green"
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Box>
          <Text bold color="green">
            📝 Proposed Patch Preview:
          </Text>
          <Text bold color="yellow"> {patch.filePath}</Text>
        </Box>
        <Box>
          <Text color="green">+{additions} </Text>
          <Text color="red">-{deletions}</Text>
        </Box>
      </Box>

      <Box marginBottom={1}>
        <Text italic dimColor>{patch.description}</Text>
      </Box>

      <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor="gray">
        {diffLines.map((line, idx) => {
          if (line.startsWith('+++') || line.startsWith('---')) {
            return (
              <Text key={idx} bold color="gray">
                {line}
              </Text>
            );
          }
          if (line.startsWith('@@')) {
            return (
              <Text key={idx} color="cyan">
                {line}
              </Text>
            );
          }
          if (line.startsWith('+')) {
            return (
              <Text key={idx} color="green">
                {line}
              </Text>
            );
          }
          if (line.startsWith('-')) {
            return (
              <Text key={idx} color="red">
                {line}
              </Text>
            );
          }
          return (
            <Text key={idx} dimColor>
              {line}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
};
