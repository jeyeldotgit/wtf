import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { TextInput } from '@inkjs/ui';

interface QuestionModalProps {
  onSubmit: (question: string) => void;
  onCancel: () => void;
}

export const QuestionModal: React.FC<QuestionModalProps> = ({
  onSubmit,
  onCancel,
}) => {
  const [val, setVal] = useState('');
  const isInteractive = Boolean(process.stdin.isTTY);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      marginTop={1}
    >
      <Box marginBottom={1}>
        <Text bold color="magenta">
          💬 Ask WTF about this failure:
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>Type your question and press Enter (or press Esc/leave empty to cancel):</Text>
      </Box>
      <Box>
        <Text color="cyan">&gt; </Text>
        <TextInput
          placeholder="e.g. Why did we need to add the return type here?"
          onChange={setVal}
          isDisabled={!isInteractive}
          onSubmit={(submitted) => {
            if (!submitted.trim()) {
              onCancel();
            } else {
              onSubmit(submitted);
            }
          }}
        />
      </Box>
    </Box>
  );
};
