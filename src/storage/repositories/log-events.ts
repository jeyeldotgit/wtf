import type { DatabaseSync } from "node:sqlite";

export type LogEventRecord = {
  id: number;
  runId: string;
  stream: "stdout" | "stderr";
  sequence: number;
  content: string;
  createdAt: string;
};

export function getLogEvents(database: DatabaseSync, projectId: string, runId: string, limit: number): LogEventRecord[] {
  const rows = database.prepare(`
    SELECT e.id, e.run_id, e.stream, e.sequence, e.content, e.created_at
    FROM log_events e JOIN runs r ON r.id = e.run_id
    WHERE r.project_id = ? AND e.run_id = ?
    ORDER BY e.sequence DESC LIMIT ?
  `).all(projectId, runId, limit) as Array<Record<string, string | number>>;
  return rows.map(mapLogEvent).reverse();
}

export function searchLogEvents(database: DatabaseSync, input: {
  projectId: string;
  query: string;
  runId?: string;
  limit: number;
}): LogEventRecord[] {
  const escaped = input.query.replace(/[\\%_]/g, "\\$&");
  const clauses = ["r.project_id = ?", "e.content LIKE ? ESCAPE '\\'"];
  const parameters: Array<string | number> = [input.projectId, `%${escaped}%`];
  if (input.runId) {
    clauses.push("e.run_id = ?");
    parameters.push(input.runId);
  }
  parameters.push(input.limit + 1);
  const rows = database.prepare(`
    SELECT e.id, e.run_id, e.stream, e.sequence, e.content, e.created_at
    FROM log_events e JOIN runs r ON r.id = e.run_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY e.created_at DESC, e.id DESC LIMIT ?
  `).all(...parameters) as Array<Record<string, string | number>>;
  return rows.map(mapLogEvent);
}

function mapLogEvent(row: Record<string, string | number>): LogEventRecord {
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    stream: String(row.stream) as "stdout" | "stderr",
    sequence: Number(row.sequence),
    content: String(row.content),
    createdAt: String(row.created_at),
  };
}
