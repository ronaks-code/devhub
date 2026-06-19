/* In-process HTTP smoke test (no network) against the pre-seeded smoke DB. */
import { buildApp } from "../src/app.js";
import { Engine } from "@devhub/engine";

const engine = new Engine("/tmp/claude-ui-smoke.db");
const { app } = buildApp({ engine });

const health = await app.inject({ method: "GET", url: "/api/health" });
console.log("health:", health.json());

const projects = (await app.inject({ method: "GET", url: "/api/projects" })).json() as Array<{
  id: string;
  name: string;
  sessionCount: number;
}>;
console.log("projects:", projects.length);

const proj = projects.find((p) => p.sessionCount > 0)!;
const sessions = (
  await app.inject({ method: "GET", url: `/api/projects/${proj.id}/sessions` })
).json() as Array<{ sessionId: string; title: string; messageCount: number }>;
console.log(`sessions in "${proj.name}":`, sessions.length);

const s = sessions[0]!;
const page = (
  await app.inject({ method: "GET", url: `/api/sessions/${s.sessionId}/messages` })
).json() as { messages: unknown[]; truncatedFromStart: boolean };
console.log(`messages for "${s.title}":`, page.messages.length, "truncated:", page.truncatedFromStart);

// rename round-trip (sidecar)
await app.inject({
  method: "PATCH",
  url: `/api/sessions/${s.sessionId}`,
  payload: { customTitle: "RENAMED ✔" },
});
const after = (
  await app.inject({ method: "GET", url: `/api/projects/${proj.id}/sessions` })
).json() as Array<{ sessionId: string; title: string; titleSource: string }>;
const renamed = after.find((x) => x.sessionId === s.sessionId)!;
console.log("after rename:", renamed.title, `(${renamed.titleSource})`);

// clear it again so re-runs are clean
await app.inject({ method: "PATCH", url: `/api/sessions/${s.sessionId}`, payload: { customTitle: null } });

await app.close();
engine.close();
console.log("\nSERVER OK");
