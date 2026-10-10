import React from "react";
import { Box, Text } from "ink";
import { Badge } from "@inkjs/ui";
import { UIState } from "../types/index.js";

interface HeaderProps {
  state: UIState;
}

export const Header: React.FC<HeaderProps> = ({ state }) => {
  const getBadge = () => {
    switch (state) {
      case "shell_ready":
        return <Badge color="gray">SHELL READY</Badge>;
      case "running_command":
        return <Badge color="yellow">COMMAND RUNNING</Badge>;
      case "investigating":
        return <Badge color="yellow">INVESTIGATING</Badge>;
      case "diagnosed":
        return <Badge color="cyan">DIAGNOSIS READY</Badge>;
      case "needs_input":
        return <Badge color="blue">NEEDS INPUT</Badge>;
      case "proposal_available":
        return <Badge color="cyan">PROPOSAL</Badge>;
      case "failed":
        return <Badge color="red">INVESTIGATION FAILED</Badge>;
      case "session_ended":
        return <Badge color="gray">SESSION ENDED</Badge>;
      default:
        return <Badge color="gray">WTF</Badge>;
    }
  };

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between" alignItems="center">
        <Box>
          <Text bold color="magenta">
            WTF
          </Text>
        </Box>
        <Box>{getBadge()}</Box>
      </Box>
      <Box>
        <Text dimColor>{"─".repeat(60)}</Text>
      </Box>
    </Box>
  );
};
