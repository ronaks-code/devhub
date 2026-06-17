/* Smoke test the engine against the REAL ~/.claude data. Run: pnpm tsx scripts/smoke.ts */
import { stat } from "node:fs/promises";
import { Engine } from "../src/index.js";
import { scanAllSessionFiles } from "../src/discovery.js";
import { readSessionMessages, readTail } from "../src/parser.js";

const DB = "/tmp/claude-ui-smoke.db";

function ms(start: number): string {
  return `${(performance.now() - start).toFixed(0)}ms`;
}

async function main() {
  console.log("== discovery ==");
  const files = await scanAllSessionFiles();
  console.log(`scanned ${files.length} session files`);

  // largest file (the huge-transcript stress case)
  let biggest = { path: "", size: 0 };
  for (const f of files) {
    try {
      const s = await stat(f);
      if (s.size > biggest.size) biggest = { path: f, size: s.size };
    } catch {}
  }
  console.log(`biggest: ${(biggest.size / 1e6).toFixed(1)}MB  ${biggest.path}`);

  console.log("\n== huge-file tail read (no OOM) ==");
  if (biggest.path) {
    const t = performance.now();
    const { messages, truncatedFromStart } = await readSessionMessages(biggest.path);
    console.log(
      `read ${messages.length} msgs from ${(biggest.size / 1e6).toFixed(1)}MB in ${ms(t)} (truncatedFromStart=${truncatedFromStart})`,
    );
    const heap = process.memoryUsage().heapUsed / 1e6;
    console.log(`heapUsed after: ${heap.toFixed(0)}MB`);
  }

  console.log("\n== index a subset (correctness, cheap) ==");
  const engine = new Engine(DB);
  // index small-to-medium files first so we don't read GBs in a smoke test
  const withSizes = await Promise.all(
    files.map(async (f) => ({ f, size: (await stat(f).catch(() => ({ size: 1e18 }))).size })),
  );
  withSizes.sort((a, b) => a.size - b.size);
  const subset = withSizes.slice(0, 120).map((x) => x.f);
  const t = performance.now();
  let added = 0;
  for (const f of subset) {
    const r = await engine.index.indexSession(f);
    if (r === "added") added++;
  }
  console.log(`indexed ${subset.length} files in ${ms(t)} (added ${added})`);

  console.log("\n== projects (grouped by true cwd, orphan recovery) ==");
  const projects = engine.getProjects();
  console.log(`${projects.length} projects from ${engine.index.getSessionCount()} indexed sessions`);
  for (const p of projects.slice(0, 8)) {
    const orphan = p.encodedFolders.length > 1 ? `  <-- ${p.encodedFolders.length} folders merged` : "";
    console.log(
      `  ${p.name.padEnd(28)} ${String(p.sessionCount).padStart(3)} sessions  ${p.cwd}${orphan}`,
    );
  }

  console.log("\n== a session detail ==");
  const withMsgs = projects.find((p) => p.sessionCount > 0);
  if (withMsgs) {
    const sessions = engine.getProjectSessions(withMsgs.id);
    const s = sessions.find((x) => x.messageCount > 0) ?? sessions[0]!;
    console.log(`session: "${s.title}" (${s.titleSource})  ${s.messageCount} msgs  cwd=${s.cwd}`);
    console.log(
      `usage: in=${s.usage.inputTokens} out=${s.usage.outputTokens} cacheR=${s.usage.cacheReadTokens}`,
    );
    const page = await engine.getSessionMessages(s.sessionId);
    if (page) {
      const roles = page.messages.reduce<Record<string, number>>((acc, m) => {
        acc[m.role] = (acc[m.role] ?? 0) + 1;
        return acc;
      }, {});
      console.log(`rendered ${page.messages.length} msgs, roles:`, roles, `subagents=${page.subagents.length}`);
    }
  }

  engine.close();
  console.log("\nOK");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
