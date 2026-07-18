import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { emptySeed } from "../src/parse-session.js";
import { closeScanWorker, runScanInWorker } from "../src/index-worker.js";

const roots: string[] = [];

afterEach(async () => {
  await closeScanWorker();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("index worker module loading", () => {
  it("loads the TypeScript worker and parser directly without sync fallback", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "devhub-index-worker-"));
    roots.push(root);
    const file = path.join(root, "session.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({
        type: "user",
        cwd: "/repo",
        timestamp: "2026-07-18T00:00:00.000Z",
        message: { role: "user", content: "worker direct proof" },
      })}\n`,
    );

    const result = await runScanInWorker(file, 0, emptySeed());

    expect(result.messageCount).toBe(1);
    expect(result.firstPrompt).toBe("worker direct proof");
  });
});
