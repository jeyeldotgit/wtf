import React from 'react';
import { Box, Text } from 'ink';
import type { Diagnosis } from '../../agents/schemas.js';
import { sanitizeTerminalText } from '../../shared/terminal-text.js';

interface ExplanationProps {
  diagnosis: Diagnosis;
}

export const Explanation: React.FC<ExplanationProps> = ({ diagnosis }) => (
  <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
    <Text bold color="cyan">Diagnosis</Text>
    <Text>{sanitizeTerminalText(diagnosis.summary)}</Text>

    {diagnosis.likelyCause && (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Model inference: likely cause <Text color="yellow">({diagnosis.likelyCause.confidence} confidence)</Text></Text>
        <Text>{sanitizeTerminalText(diagnosis.likelyCause.cause)}</Text>
        <Text dimColor>{sanitizeTerminalText(diagnosis.likelyCause.rationale)}</Text>
        <Text dimColor>Cites: {sanitizeTerminalText(diagnosis.likelyCause.evidenceIds.join(', '))}</Text>
      </Box>
    )}

    <Box flexDirection="column" marginTop={1}>
      <Text bold>What this means</Text>
      {diagnosis.beginnerExplanation.map((point, index) => (
        <Box key={`${index}-${point}`} marginLeft={1}>
          <Text color="cyan">• </Text>
          <Text>{sanitizeTerminalText(point)}</Text>
        </Box>
      ))}
    </Box>
  </Box>
);
