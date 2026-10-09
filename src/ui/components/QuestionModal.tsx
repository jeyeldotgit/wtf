import React from 'react';
import { Box, Text } from 'ink';

interface QuestionModalProps {
  question: string;
}

export const QuestionModal: React.FC<QuestionModalProps> = ({ question }) => (
  <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
    <Text bold color="magenta">More information is needed</Text>
    <Text>{question}</Text>
    <Text dimColor>No answer was generated or submitted.</Text>
  </Box>
);
