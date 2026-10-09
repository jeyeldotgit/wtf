import React from 'react';
import { Box, Text } from 'ink';
import type { Diagnosis } from '../../agents/schemas.js';

type VerificationSuggestion = NonNullable<Diagnosis['verificationCommand']>;

interface VerificationCardProps {
  verification: VerificationSuggestion;
}

export const VerificationCard: React.FC<VerificationCardProps> = ({ verification }) => (
  <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
    <Text bold color="magenta">Suggested verification (not run)</Text>
    <Text color="yellow">{verification.command}</Text>
    <Text dimColor>{verification.reason}</Text>
  </Box>
);
