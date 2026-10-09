import {
  evaluate,
  Dataset,
  Laminar,
  LaminarAiSdkTelemetry,
  LaminarDataset,
  type Datapoint,
} from "@lmnr-ai/lmnr";
import { registerTelemetry } from "ai";
import {
  RunAgentInputSchema,
  RunAgentResultSchema,
  type RunAgentInput,
  type RunAgentResult,
} from "../src/agents/schemas.js";
import { runAgent } from "../src/agents/run-agent.js";
import { RUN_AGENT_PROMPT_VERSION } from "../src/agents/system/prompt.js";

const DATASET_NAME = "wtf-local-run-agent-v1";
const EVAL_REPEATS = 1;

type ArgumentCheck = {
  toolName: string;
  field: string;
  includes: string;
};

type EvalTarget = {
  expectedKind: RunAgentResult["kind"];
  allowedTools: string[];
  requiredTools: string[];
  requiresQuestion: boolean;
  forbidsFix: boolean;
  argumentChecks?: ArgumentCheck[];
  forbiddenArgumentTerms: string[];
};

type EvalOutput = {
  result?: RunAgentResult;
  knownEvidenceIds: string[];
  error?: string;
};

class RepeatedDataset extends Dataset<RunAgentInput, EvalTarget> {
  private baseSize?: number;

  constructor(
    private readonly dataset: LaminarDataset<RunAgentInput, EvalTarget>,
    private readonly repeats: number,
  ) {
    super();
  }

  private async sizeOfBase(): Promise<number> {
    this.baseSize ??= await this.dataset.size();
    return this.baseSize;
  }

  async size(): Promise<number> {
    return (await this.sizeOfBase()) * this.repeats;
  }

  // Forward this so Laminar can attach its API client to the wrapped dataset.
  sourceDataset(): LaminarDataset<RunAgentInput, EvalTarget> | undefined {
    return this.dataset.sourceDataset();
  }

  async get(index: number): Promise<Datapoint<RunAgentInput, EvalTarget>> {
    const size = await this.sizeOfBase();
    if (size === 0) throw new Error("The Laminar dataset is empty");
    const datapoint = await this.dataset.get(index % size);
    return {
      ...datapoint,
      metadata: {
        ...datapoint.metadata,
        evalAttempt: Math.floor(index / size) + 1,
      },
    };
  }
}

function getField(object: unknown, field: string): unknown {
  return field.split(".").reduce<unknown>((value, key) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, object);
}

function toolRequests(result: RunAgentResult | undefined) {
  return result?.kind === "tool_requests" ? result.requests : [];
}

function hasKnownEvidence(
  result: RunAgentResult | undefined,
  knownIds: string[],
): boolean {
  if (!result || result.kind !== "diagnosis") return result !== undefined;
  const known = new Set(knownIds);
  const ids = [
    ...result.diagnosis.observations.flatMap((item) => item.evidenceIds),
    ...(result.diagnosis.likelyCause?.evidenceIds ?? []),
    ...(result.diagnosis.proposedFix?.evidenceIds ?? []),
  ];
  return ids.length > 0 && ids.every((id) => known.has(id));
}

const evaluators = {
  "outcome-kind": (output: EvalOutput, target?: EvalTarget) =>
    output.result?.kind === target?.expectedKind ? 1 : 0,

  "tool-policy": (output: EvalOutput, target?: EvalTarget) => {
    const names = toolRequests(output.result).map(
      (request) => request.toolName,
    );
    const allowed = target?.allowedTools ?? [];
    const required = target?.requiredTools ?? [];
    return names.every((name) => allowed.includes(name)) &&
      required.every((name) => names.some((toolName) => toolName === name))
      ? 1
      : 0;
  },

  "no-duplicate-tool-requests": (output: EvalOutput) => {
    const requests = toolRequests(output.result);
    const keys = requests.map(
      (request) => request.toolName + ":" + JSON.stringify(request.input),
    );
    return new Set(keys).size === keys.length ? 1 : 0;
  },

  "tool-arguments": (output: EvalOutput, target?: EvalTarget) => {
    const requests = toolRequests(output.result);
    return (target?.argumentChecks ?? []).every((check) => {
      const matching = requests.find(
        (request) => request.toolName === check.toolName,
      );
      const value = getField(matching?.input, check.field);
      return (
        value !== undefined &&
        String(value).toLowerCase().includes(check.includes.toLowerCase())
      );
    })
      ? 1
      : 0;
  },

  "safe-tool-arguments": (output: EvalOutput, target?: EvalTarget) => {
    const serialized = JSON.stringify(
      toolRequests(output.result),
    ).toLowerCase();
    return (target?.forbiddenArgumentTerms ?? []).every(
      (term) => !serialized.includes(term.toLowerCase()),
    )
      ? 1
      : 0;
  },

  "evidence-grounding": (output: EvalOutput) =>
    hasKnownEvidence(output.result, output.knownEvidenceIds) ? 1 : 0,

  "question-and-fix-policy": (output: EvalOutput, target?: EvalTarget) => {
    if (output.error || !output.result) return 0;
    if (output.result.kind !== "diagnosis") {
      return target?.requiresQuestion ? 0 : 1;
    }
    const hasQuestion = output.result.diagnosis.missingInformation.length === 1;
    const hasFix = output.result.diagnosis.proposedFix !== undefined;
    return hasQuestion === Boolean(target?.requiresQuestion) &&
      (!target?.forbidsFix || !hasFix)
      ? 1
      : 0;
  },

  "safe-diagnosis-content": (output: EvalOutput, target?: EvalTarget) => {
    const serialized = JSON.stringify(
      output.result ?? output.error ?? "",
    ).toLowerCase();
    return (target?.forbiddenArgumentTerms ?? []).every(
      (term) => !serialized.includes(term.toLowerCase()),
    )
      ? 1
      : 0;
  },
};

async function main(): Promise<void> {
  const projectApiKey = process.env.LMNR_PROJECT_API_KEY;
  if (!projectApiKey) {
    throw new Error(
      "Set LMNR_PROJECT_API_KEY before running the Laminar evaluation.",
    );
  }

  // Eval inputs are synthetic. Telemetry is deliberately initialized only in this runner.
  Laminar.initialize({
    projectApiKey,
    instrumentModules: {},
    metadata: { application: "wtf-local", evaluationData: "synthetic" },
  });
  registerTelemetry(new LaminarAiSdkTelemetry());

  const dataset = new RepeatedDataset(
    new LaminarDataset<RunAgentInput, EvalTarget>(DATASET_NAME, {
      fetchSize: 20,
    }),
    EVAL_REPEATS,
  );

  try {
    await evaluate({
      data: dataset,
      name: "run-agent-toolcalls-v1",
      groupName: "wtf-local-agent",
      executor: async (rawInput: RunAgentInput): Promise<EvalOutput> => {
        const input = RunAgentInputSchema.parse(rawInput);
        try {
          const result = RunAgentResultSchema.parse(await runAgent(input));
          return {
            result,
            knownEvidenceIds: input.evidence.map((item) => item.id),
          };
        } catch (error) {
          return {
            knownEvidenceIds: input.evidence.map((item) => item.id),
            error:
              error instanceof Error
                ? error.name + ": " + error.message
                : "Unknown agent error",
          };
        }
      },
      evaluators,
      metadata: {
        model: process.env.WTF_MODEL ?? "qwen2.5-coder:3b",
        repeats: EVAL_REPEATS,
        promptVersion: RUN_AGENT_PROMPT_VERSION,
      },
    });
  } finally {
    await Laminar.flush();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Laminar agent evaluation failed: " + message);
  process.exitCode = 1;
});
