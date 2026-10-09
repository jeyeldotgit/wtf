import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import {
  Header,
  ErrorEvidence,
  Explanation,
  DiffViewer,
  VerificationCard,
  ApprovalPrompt,
  QuestionModal,
} from '../components/index.js';
import { InvestigationData, UIState } from '../types/index.js';
import { testScenarios } from '../test-scenarios.js';

export interface InvestigationViewProps {
  initialScenarioIndex?: number;
  onExit?: () => void;
}

export const InvestigationView: React.FC<InvestigationViewProps> = ({
  initialScenarioIndex = 0,
  onExit,
}) => {
  const [activeScenarioIdx, setActiveScenarioIdx] = useState<number>(initialScenarioIndex);
  const [data, setData] = useState<InvestigationData>(testScenarios[initialScenarioIndex].data);
  const [verificationOutput, setVerificationOutput] = useState<string[]>([]);
  const [userQuestionResponse, setUserQuestionResponse] = useState<string | null>(null);

  const isInteractive = Boolean(process.stdin.isTTY);

  // Allow switching test scenarios using keys 1, 2, 3
  useInput(
    (input) => {
      const num = parseInt(input, 10);
      if (num >= 1 && num <= testScenarios.length) {
        const nextIdx = num - 1;
        setActiveScenarioIdx(nextIdx);
        setData(testScenarios[nextIdx].data);
        setVerificationOutput([]);
        setUserQuestionResponse(null);
      }
    },
    { isActive: isInteractive }
  );

  const handleApprovePatch = () => {
    setData((prev) => ({
      ...prev,
      state: 'patch_approved',
    }));
  };

  const handleRejectPatch = () => {
    setData((prev) => ({
      ...prev,
      state: 'patch_rejected',
    }));
  };

  const handleRunVerification = () => {
    setData((prev) => ({
      ...prev,
      state: 'verifying',
    }));

    setTimeout(() => {
      setVerificationOutput([
        `> Running verification: ${data.verification?.command || 'test'}`,
        '✔ Verification passed! All checks succeeded.',
      ]);
      setData((prev) => ({
        ...prev,
        state: 'verified_success',
      }));
    }, 1200);
  };

  const handleSkipVerification = () => {
    if (onExit) onExit();
  };

  const handleAskQuestion = () => {
    setData((prev) => ({
      ...prev,
      state: 'asking_question',
    }));
  };

  const handleSubmitQuestion = (q: string) => {
    setUserQuestionResponse(
      `Q: "${q}"\nWTF Answer: This error occurred because of type mismatch or missing definitions. The proposed patch safely handles the edge case.`
    );
    setData((prev) => ({
      ...prev,
      state: 'diagnosis_ready',
    }));
  };

  const handleCancelQuestion = () => {
    setData((prev) => ({
      ...prev,
      state: 'diagnosis_ready',
    }));
  };

  const handleReset = () => {
    // Reset current scenario back to initial diagnosis
    setData(testScenarios[activeScenarioIdx].data);
    setVerificationOutput([]);
    setUserQuestionResponse(null);
  };

  return (
    <Box flexDirection="column" padding={1}>
      {/* Test Scenario Switcher Toolbar */}
      <Box
        justifyContent="space-between"
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        marginBottom={1}
      >
        <Text bold color="cyan">🧪 TEST SCENARIOS (Press 1, 2, or 3 to switch):</Text>
        <Box>
          {testScenarios.map((sc, idx) => (
            <Box key={sc.id} marginLeft={1}>
              <Text
                bold={idx === activeScenarioIdx}
                color={idx === activeScenarioIdx ? 'yellow' : 'gray'}
              >
                [{idx + 1}] {sc.id}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>

      <Header state={data.state} />

      <ErrorEvidence failure={data.failure} />

      {data.state === 'investigating' && (
        <Box marginY={1}>
          <Spinner label="WTF is investigating failure & gathering project context..." />
        </Box>
      )}

      {data.fix && data.state !== 'investigating' && (
        <>
          <Explanation fix={data.fix} />
          <DiffViewer patch={data.fix} />
        </>
      )}

      {userQuestionResponse && (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="blue"
          paddingX={1}
          marginBottom={1}
        >
          <Text bold color="blue">
            💬 Follow-up Explanation:
          </Text>
          <Text>{userQuestionResponse}</Text>
        </Box>
      )}

      {data.verification && (
        <VerificationCard
          state={data.state}
          verification={data.verification}
          outputSnippet={verificationOutput}
        />
      )}

      {data.state === 'asking_question' ? (
        <QuestionModal
          onSubmit={handleSubmitQuestion}
          onCancel={handleCancelQuestion}
        />
      ) : (
        <ApprovalPrompt
          state={data.state}
          onApprovePatch={handleApprovePatch}
          onRejectPatch={handleRejectPatch}
          onRunVerification={handleRunVerification}
          onSkipVerification={handleSkipVerification}
          onAskQuestion={handleAskQuestion}
          onReset={handleReset}
        />
      )}
    </Box>
  );
};
