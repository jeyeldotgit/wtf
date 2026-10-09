import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { LaminarClient, type Datapoint } from "@lmnr-ai/lmnr";
import { z } from "zod";
import { RunAgentInputSchema, type RunAgentInput } from "../src/agents/schemas.js";

const DATASET_NAME = "wtf-local-run-agent-v1";
const DATASET_PATH = fileURLToPath(new URL("./datasets/run-agent-toolcalls-v1.jsonl", import.meta.url));

const EvalTargetSchema = z.object({
  expectedKind: z.enum(["diagnosis", "tool_requests"]),
  allowedTools: z.array(z.string()),
  requiredTools: z.array(z.string()),
  requiresQuestion: z.boolean(),
  forbidsFix: z.boolean(),
  argumentChecks: z.array(z.object({
    toolName: z.string(),
    field: z.string(),
    includes: z.string(),
  }).strict()).optional(),
  forbiddenArgumentTerms: z.array(z.string()),
}).strict();

const DatasetRowSchema = z.object({
  data: RunAgentInputSchema,
  target: EvalTargetSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

type EvalTarget = z.infer<typeof EvalTargetSchema>;

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "create" && mode !== "push") {
    throw new Error("Usage: sync-laminar-dataset.ts <create|push>");
  }

  const projectApiKey = process.env.LMNR_PROJECT_API_KEY;
  if (!projectApiKey) {
    throw new Error("Set LMNR_PROJECT_API_KEY before syncing the Laminar dataset.");
  }

  const contents = await readFile(DATASET_PATH, "utf8");
  const points = contents
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return DatasetRowSchema.parse(JSON.parse(line)) as Datapoint<RunAgentInput, EvalTarget>;
      } catch (error) {
        throw new Error("Invalid synthetic dataset row " + (index + 1), { cause: error });
      }
    });
  if (points.length === 0) throw new Error("The synthetic Laminar dataset is empty.");

  const client = new LaminarClient({ projectApiKey });
  const matchingDatasets = await client.datasets.getDatasetByName(DATASET_NAME);

  if (mode === "create" && matchingDatasets.length > 0) {
    throw new Error("Dataset already exists; use pnpm eval:dataset:push to append datapoints.");
  }
  if (mode === "push" && matchingDatasets.length === 0) {
    throw new Error("Dataset does not exist; create it first with pnpm eval:dataset:create.");
  }

  const datasetId = mode === "create"
    ? (await client.datasets.create(DATASET_NAME)).id
    : matchingDatasets[0].id;
  await client.datasets.push({ points, id: datasetId });
  console.log("Synced " + points.length + " synthetic datapoints to " + DATASET_NAME + ".");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Laminar dataset sync failed: " + message);
  process.exitCode = 1;
});
