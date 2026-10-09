import React from 'react';
import { Box, Text } from 'ink';
import type { Diagnosis } from '../../agents/schemas.js';

interface ExplanationProps {
  diagnosis: Diagnosis;
}

export const Explanation: React.FC<ExplanationProps> = ({ diagnosis }) => (
  <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
    <Text bold color="cyan">Diagnosis</Text>
    <Text>{diagnosis.summary}</Text>

    <Box flexDirection="column" marginTop={1}>
      <Text bold>What the evidence shows</Text>
      {diagnosis.observations.map((observation, index) => (
        <Box key={`${index}-${observation.statement}`} flexDirection="column" marginLeft={1}>
          <Text>{observation.statement}</Text>
          <Text dimColor>Cites: {observation.evidenceIds.join(', ')}</Text>
        </Box>
      ))}
    </Box>

    {diagnosis.likelyCause && (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Likely cause <Text color="yellow">({diagnosis.likelyCause.confidence} confidence)</Text></Text>
        <Text>{diagnosis.likelyCause.cause}</Text>
        <Text dimColor>{diagnosis.likelyCause.rationale}</Text>
        <Text dimColor>Cites: {diagnosis.likelyCause.evidenceIds.join(', ')}</Text>
      </Box>
    )}

    <Box flexDirection="column" marginTop={1}>
      <Text bold>What this means</Text>
      {diagnosis.beginnerExplanation.map((point, index) => (
        <Box key={`${index}-${point}`} marginLeft={1}>
          <Text color="cyan">• </Text>
          <Text>{point}</Text>
        </Box>
      ))}
    </Box>
  </Box>
);
