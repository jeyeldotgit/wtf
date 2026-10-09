import React from 'react';
import { Box, Text } from 'ink';
import { FixPatch } from '../types/index.js';

interface ExplanationProps {
  fix: FixPatch;
}

export const Explanation: React.FC<ExplanationProps> = ({ fix }) => {
  const getConfidenceColor = () => {
    switch (fix.confidence) {
      case 'high':
        return 'green';
      case 'medium':
        return 'yellow';
      case 'low':
        return 'red';
      default:
        return 'white';
    }
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginBottom={1}
    >
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="cyan">
          💡 Teaching & Concept Explanation
        </Text>
        <Box>
          <Text dimColor>Confidence: </Text>
          <Text bold color={getConfidenceColor()}>
            {fix.confidence.toUpperCase()}
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="white">
          Why this happened:
        </Text>
        {fix.conceptExplanation.map((point, idx) => (
          <Box key={idx} marginLeft={1}>
            <Text color="cyan">• </Text>
            <Text>{point}</Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column">
        <Text bold color="white">
          How this fix resolves it:
        </Text>
        <Box marginLeft={1}>
          <Text color="green">✔ </Text>
          <Text>{fix.whyFixWorks}</Text>
        </Box>
      </Box>
    </Box>
  );
};
