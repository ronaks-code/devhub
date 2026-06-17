/* Live driver smoke test. Run: pnpm exec tsx scripts/driver-smoke.ts */
import { mkdirSync, rmSync, readdirSync } from "node:fs";
import { createDriver } from "../src/driver/cli.js";

const dir = "/tmp/cui-driver-smoke";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const driver = createDriver();

function runTurn(prompt: string, sessionId?: string) {
  return new Promise<{ sessionId: string | null; text: string }>((resolve) => {
    let sid: string | null = sessionId ?? null;
    const texts: string[] = [];
    const turn = driver.runTurn(
      { cwd: dir, prompt, sessionId, model: "claude-haiku-4-5-20251001", permissionMode: "acceptEdits" },
      {
        onSession: (id) => {
          sid = id;
          console.log("  session:", id.slice(0, 8));
        },
        onMessage: (m) => {
          const kinds = m.blocks.map((b) => b.type + (b.type === "tool_use" ? `(${b.name})` : ""));
          console.log(`  ${m.role}:`, kinds.join(", "));
          for (const b of m.blocks) if (b.type === "text") texts.push(b.text);
        },
        onResult: (r) =>
          console.log(`  result: ${r.subtype} cost=$${r.costUsd.toFixed(4)} denials=${r.denials.length}`),
        onError: (e) => console.log("  ERROR:", e),
      },
    );
    turn.done.then(() => resolve({ sessionId: sid, text: texts.join(" ") }));
  });
}

console.log("== turn 1: write a file (acceptEdits) ==");
const t1 = await runTurn("Create a file named greeting.txt containing exactly: hi from claude-ui. Then say done.");
console.log("files in cwd:", readdirSync(dir));

console.log("\n== turn 2: resume + recall context ==");
const t2 = await runTurn("What is the exact content of greeting.txt? Reply with just that content.", t1.sessionId ?? undefined);
console.log("recall text:", JSON.stringify(t2.text.slice(0, 80)));
console.log("same session:", t2.sessionId === t1.sessionId);

console.log("\nDRIVER OK");
process.exit(0);
