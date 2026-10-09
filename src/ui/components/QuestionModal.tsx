import React from 'react';
import { Box, Text } from 'ink';
import { TextInput } from '@inkjs/ui';
import { sanitizeTerminalText } from '../../shared/terminal-text.js';

interface QuestionModalProps {
  question: string;
  disabled?: boolean;
  onAnswer?: (answer: string) => void;
}

export const QuestionModal: React.FC<QuestionModalProps> = ({ question, disabled, onAnswer }) => (
  <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1}>
    <Text bold color="magenta">More information is needed</Text>
    <Text>{sanitizeTerminalText(question)}</Text>
    {onAnswer && process.stdin.isTTY && <TextInput isDisabled={disabled} placeholder="Answer the question and press Enter"
      onSubmit={answer => { if (answer.trim()) onAnswer(answer); }} />}
  </Box>
);
