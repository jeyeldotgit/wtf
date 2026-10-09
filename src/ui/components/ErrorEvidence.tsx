import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Diagnosis, RunAgentEvidence } from '../../agents/schemas.js';
import type { RunSummary } from '../adapters/investigation-view-model.js';
import { sanitizeTerminalText } from '../../shared/terminal-text.js';

interface ErrorEvidenceProps {
  run: RunSummary;
  output: string;
  evidence: RunAgentEvidence[];
  observations?: Diagnosis['observations'];
}

export const ErrorEvidence: React.FC<ErrorEvidenceProps> = ({ run, output, evidence, observations = [] }) => {
  const [expanded, setExpanded] = useState(false);
  useInput((input, key) => { if (key.ctrl && input === 'e') setExpanded(value => !value); }, { isActive: Boolean(process.stdin.isTTY) });
  const byId = new Map(evidence.map(item => [item.id, item]));
  const status = run.exitCode === null ? 'exit status unavailable' : `exit code ${run.exitCode}`;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color={run.status === 'failed' ? 'red' : 'green'}>
          {run.status === 'failed' ? 'Command failed:' : run.status === 'cancelled' ? 'Command interrupted:' : 'Command completed:'}
        </Text>
        <Text color="yellow"> {sanitizeTerminalText(run.commandDisplay)}</Text>
        <Text dimColor> ({status})</Text>
      </Box>

      {output && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
          <Text bold dimColor>Captured output</Text>
          <Text>{sanitizeTerminalText(output)}</Text>
        </Box>
      )}

      {evidence.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} marginTop={1}>
          <Text bold color="white">Evidence used for this diagnosis</Text>
          <Text dimColor>Ctrl+E {expanded ? 'collapses' : 'expands'} cited evidence excerpts.</Text>
          {observations.map((observation, index) => <Box key={index} flexDirection="column" marginTop={1}>
            <Text>{sanitizeTerminalText(observation.statement)}</Text>
            <Text dimColor>Cites: {sanitizeTerminalText(observation.evidenceIds.join(', '))}</Text>
            {expanded && observation.evidenceIds.map(id => {
              const item = byId.get(id);
              return item ? <Box key={id} flexDirection="column" marginLeft={2}>
                <Text color="cyan">{sanitizeTerminalText(item.id)} · {item.sourceType}{item.relativePath ? ` · ${item.relativePath}` : ''}</Text>
                <Text>{sanitizeTerminalText(item.excerpt)}</Text>
              </Box> : null;
            })}
          </Box>)}
        </Box>
      )}
    </Box>
  );
};
