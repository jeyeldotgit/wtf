import React from 'react';
import { Box, Text, useInput } from 'ink';
import { UIState } from '../types/index.js';

interface ApprovalPromptProps {
  state: UIState;
  onApprovePatch: () => void;
  onRejectPatch: () => void;
  onRunVerification: () => void;
  onSkipVerification: () => void;
  onAskQuestion: () => void;
  onReset: () => void;
}

export const ApprovalPrompt: React.FC<ApprovalPromptProps> = ({
  state,
  onApprovePatch,
  onRejectPatch,
  onRunVerification,
  onSkipVerification,
  onAskQuestion,
  onReset,
}) => {
  const isInteractive = Boolean(process.stdin.isTTY);

  useInput(
    (input, key) => {
      const keyLower = input.toLowerCase();

      if (state === 'diagnosis_ready') {
        if (keyLower === 'a' || keyLower === 'y') {
          onApprovePatch();
        } else if (keyLower === 'd' || keyLower === 'n') {
          onRejectPatch();
        } else if (keyLower === 'q') {
          onAskQuestion();
        }
      } else if (state === 'patch_approved') {
        if (keyLower === 'v' || keyLower === 'y') {
          onRunVerification();
        } else if (keyLower === 's' || keyLower === 'n') {
          onSkipVerification();
        }
      } else if (
        state === 'verified_success' ||
        state === 'verified_failure' ||
        state === 'patch_rejected'
      ) {
        if (key.return || keyLower === 'r') {
          onReset();
        }
      }
    },
    { isActive: isInteractive }
  );

  if (state === 'diagnosis_ready') {
    return (
      <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="bold" borderColor="cyan">
        <Text bold color="yellow">
          👉 Review & Approval Required:
        </Text>
        <Box marginTop={1}>
          <Text bold color="green"> [a] </Text>
          <Text>Approve and apply this patch</Text>
        </Box>
        <Box>
          <Text bold color="cyan"> [q] </Text>
          <Text>Ask a question about this error</Text>
        </Box>
        <Box>
          <Text bold color="red"> [d] </Text>
          <Text>Decline patch (make no changes)</Text>
        </Box>
      </Box>
    );
  }

  if (state === 'patch_approved') {
    return (
      <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="bold" borderColor="green">
        <Text bold color="green">
          ✔ Patch applied to file!
        </Text>
        <Text dimColor>Next: Run the verification test to ensure the fix resolved the error?</Text>
        <Box marginTop={1}>
          <Text bold color="yellow"> [v] </Text>
          <Text>Run verification command</Text>
        </Box>
        <Box>
          <Text bold color="gray"> [s] </Text>
          <Text>Skip verification and exit</Text>
        </Box>
      </Box>
    );
  }

  if (state === 'verified_success') {
    return (
      <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="round" borderColor="green">
        <Text bold color="green">
          🎉 All verifications passed! Issue resolved.
        </Text>
        <Box marginTop={1}>
          <Text dimColor>Press </Text>
          <Text bold color="white">[Enter]</Text>
          <Text dimColor> to return to shell session.</Text>
        </Box>
      </Box>
    );
  }

  if (state === 'verified_failure') {
    return (
      <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="round" borderColor="red">
        <Text bold color="red">
          ✗ Verification command failed.
        </Text>
        <Box marginTop={1}>
          <Text dimColor>Press </Text>
          <Text bold color="white">[r]</Text>
          <Text dimColor> to trigger next diagnosis or [Enter] to return.</Text>
        </Box>
      </Box>
    );
  }

  if (state === 'patch_rejected') {
    return (
      <Box flexDirection="column" marginTop={1} paddingX={1}>
        <Text color="yellow">Patch was declined. No changes were made.</Text>
        <Text dimColor>Press [Enter] to resume terminal.</Text>
      </Box>
    );
  }

  return null;
};
