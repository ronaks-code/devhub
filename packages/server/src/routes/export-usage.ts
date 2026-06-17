/**
 * Usage export: GET /api/export/usage?by=session|day|project&format=csv
 *
 * Streams the same usage numbers the dashboard shows, but as a downloadable CSV
 * (`text/csv` + a `Content-Disposition: attachment` filename), so the user can
 * pull their token/cost data into a spreadsheet. Three groupings:
 *
 *   by=day      → engine.dailyUsage()      one row per UTC calendar day
 *   by=session  → engine.listAllSessions() one row per session (priced by its model)
 *   by=project  → engine.getProjects()     one row per project (summed usage + cost)
 *
 * Cost is the engine's APPROXIMATE per-model estimate (`costUsd`), the same one the
 * dashboard uses — never a billed figure. `dailyUsage`/`getProjects` already carry a
 * cost; per-session we compute it here from the session's model + usage.
 *
 * `format` is accepted for forward-compat but only `csv` is implemented today; any
 * other value is a 400 so a typo doesn't silently return the wrong shape.
 */
import type { FastifyInstance } from "fastify";
import type { Engine, SessionSummary } from "@claude-ui/engine";
import { costUsd } from "@claude-ui/engine";

type GroupBy = "session" | "day" | "project";
const GROUP_BY: GroupBy[] = ["session", "day", "project"];

const exportSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    by: { type: "string", enum: [...GROUP_BY], default: "day" },
    format: { type: "string", enum: ["csv"], default: "csv" },
  },
} as const;

interface ExportQuery {
  by?: GroupBy;
  format?: "csv";
}

/**
 * Quote a single CSV field per RFC 4180: wrap in double-quotes and double any
 * inner quote when the value contains a comma, quote, or newline. Numbers/strings
 * are stringified first; null/undefined become empty.
 */
function csvField(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Join one row of pre-stringified values into a CSV line. */
function csvRow(values: unknown[]): string {
  return values.map(csvField).join(",");
}

/** Build the full CSV (header + rows) as a single string with CRLF line endings. */
function toCsv(header: string[], rows: unknown[][]): string {
  return [csvRow(header), ...rows.map(csvRow)].join("\r\n") + "\r\n";
}

/** Round a USD cost to 4 decimals (sub-cent precision) for the CSV. */
function money(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Per-session usage row: model-priced cost computed here from the session's usage. */
function sessionRow(s: SessionSummary): unknown[] {
  return [
    s.sessionId,
    s.projectId,
    s.title,
    s.model ?? "",
    s.firstTimestamp ?? "",
    s.lastTimestamp ?? "",
    s.messageCount,
    s.usage.inputTokens,
    s.usage.outputTokens,
    s.usage.cacheReadTokens,
    s.usage.cacheCreationTokens,
    money(costUsd(s.model, s.usage)),
  ];
}

/** Wire GET /api/export/usage onto an app, backed by the engine. */
export function registerExportUsageRoutes(app: FastifyInstance, engine: Engine): void {
  app.get<{ Querystring: ExportQuery }>(
    "/api/export/usage",
    { schema: { querystring: exportSchema } },
    async (req, reply) => {
      const by: GroupBy = req.query.by ?? "day";
      // `format` is schema-constrained to "csv"; the default also resolves to csv.

      let header: string[];
      let rows: unknown[][];

      if (by === "session") {
        // Every session, newest-first; cap high so an export isn't silently truncated.
        const sessions = engine.listAllSessions({ limit: 100000, offset: 0 });
        header = [
          "sessionId",
          "projectId",
          "title",
          "model",
          "firstTimestamp",
          "lastTimestamp",
          "messageCount",
          "inputTokens",
          "outputTokens",
          "cacheReadTokens",
          "cacheCreationTokens",
          "costUsd",
        ];
        rows = sessions.map(sessionRow);
      } else if (by === "project") {
        // Archived projects included so an export is a complete record. Cost is the
        // sum of the project's sessions' costs, priced by each session's own model;
        // we approximate it here from the project's summed usage (display-only).
        const projects = engine.getProjects({ includeArchived: true });
        header = [
          "projectId",
          "name",
          "cwd",
          "sessionCount",
          "lastActivity",
          "inputTokens",
          "outputTokens",
          "cacheReadTokens",
          "cacheCreationTokens",
          "costUsd",
        ];
        rows = projects.map((p) => [
          p.id,
          p.name,
          p.cwd,
          p.sessionCount,
          p.lastActivity ?? "",
          p.totalUsage.inputTokens,
          p.totalUsage.outputTokens,
          p.totalUsage.cacheReadTokens,
          p.totalUsage.cacheCreationTokens,
          money(costUsd(null, p.totalUsage)),
        ]);
      } else {
        // by=day — the engine already priced each day's cost per-session/model.
        const days = engine.dailyUsage();
        header = [
          "date",
          "inputTokens",
          "outputTokens",
          "cacheReadTokens",
          "cacheCreationTokens",
          "costUsd",
          "sessions",
        ];
        rows = days.map((d) => [
          d.date,
          d.inputTokens,
          d.outputTokens,
          d.cacheReadTokens,
          d.cacheCreationTokens,
          money(d.costUsd),
          d.sessions,
        ]);
      }

      const csv = toCsv(header, rows);
      const filename = `usage-by-${by}.csv`;
      reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`);
      return csv;
    },
  );
}
