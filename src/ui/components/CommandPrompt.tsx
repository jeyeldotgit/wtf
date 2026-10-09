import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { TextInput } from '@inkjs/ui';

interface CommandPromptProps {
  disabled: boolean;
  onSubmit: (command: string) => void;
}

export const CommandPrompt: React.FC<CommandPromptProps> = ({ disabled, onSubmit }) => {
  const [inputVersion, setInputVersion] = useState(0);
  const isInteractive = Boolean(process.stdin.isTTY);
  const isDisabled = disabled || !isInteractive;

  return (
    <Box flexDirection="column" marginTop={1}>
      {!isInteractive && <Text color="yellow">A TTY is required to enter commands.</Text>}
      {isInteractive && <Text dimColor>Commands requiring interactive stdin or a full-screen terminal are not supported.</Text>}
      <Box>
        <Text color="cyan">$ </Text>
        <TextInput
          key={inputVersion}
          placeholder="Enter a command"
          isDisabled={isDisabled}
          onSubmit={(command) => {
            if (command.trim()) onSubmit(command);
            setInputVersion((version) => version + 1);
          }}
        />
      </Box>
    </Box>
  );
};
