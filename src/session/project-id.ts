import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

export type ProjectContext = { projectId: string; projectRoot: string };

export function resolveProjectContext(root = process.cwd()): ProjectContext {
  const projectRoot = realpathSync(root);
  const projectHash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 40);
  return { projectId: `project_${projectHash}`, projectRoot };
}
