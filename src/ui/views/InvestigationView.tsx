import React, { useState } from 'react';
import { Box, Text } from 'ink';
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

export interface InvestigationViewProps {
  initialData?: InvestigationData;
  onExit?: () => void;
}

export const InvestigationView: React.FC<InvestigationViewProps> = ({
  initialData,
  onExit,
}) => {
  const [data, setData] = useState<InvestigationData>(
    initialData || {
      state: 'diagnosis_ready',
      failure: {
        command: 'pnpm run build',
        exitCode: 1,
        timestamp: new Date().toISOString(),
        cwd: '/home/jeyel/Documents/wtf',
        errorSummary: "TypeScript error TS2322: Type 'string' is not assignable to type 'number'.",
        rawLogLines: [
          "src/handlers/calc.ts:14:5 - error TS2322: Type 'string' is not assignable to type 'number'.",
          "14     const total: number = req.body.amount;",
          "                             ~~~~~~~~~~~~~~~~",
          "Found 1 error in src/handlers/calc.ts:14",
        ],
      },
      fix: {
        filePath: 'src/handlers/calc.ts',
        description: 'Parse string input from request body to integer using Number(req.body.amount)',
        conceptExplanation: [
          'HTTP request bodies parsed from JSON or URL queries often arrive as strings.',
          'TypeScript catches type mismatches at compile time to prevent runtime NaN and calculation errors.',
        ],
        whyFixWorks: 'Explicitly parses req.body.amount with Number(...) before assigning to the number type.',
        confidence: 'high',
        diff: `--- a/src/handlers/calc.ts
+++ b/src/handlers/calc.ts
@@ -11,7 +11,7 @@
 export function handleCalculation(req: Request) {
-    const total: number = req.body.amount;
+    const total: number = Number(req.body.amount);
     return { total };
 }`,
      },
      verification: {
        command: 'pnpm run build',
        description: 'Run TypeScript compiler build to verify type check succeeds.',
      },
    }
  );

  const [verificationOutput, setVerificationOutput] = useState<string[]>([]);
  const [userQuestionResponse, setUserQuestionResponse] = useState<string | null>(null);

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
        '> wtf-local@0.1.0 build',
        '> tsc -p tsconfig.json',
        '✔ Compilation finished without errors.',
      ]);
      setData((prev) => ({
        ...prev,
        state: 'verified_success',
      }));
    }, 1500);
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
      `Q: "${q}"\nWTF Answer: Since JSON request payloads can deserialize numbers or strings depending on client headers, TypeScript enforces that your variable matches strictly. Using Number() guarantees runtime safety.`
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
    if (onExit) onExit();
  };

  return (
    <Box flexDirection="column" padding={1}>
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
