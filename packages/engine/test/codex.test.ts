import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCodexStats, listCodexSessions } from "../src/codex.js";

const roots: string[] = [];
const jl = (value: unknown): string => `${JSON.stringify(value)}\n`;

function makeCodexHome(count: number): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "devhub-codex-list-"));
  roots.push(home);
  const day = path.join(home, "sessions", "2026", "07", "18");
  mkdirSync(day, { recursive: true });
  for (let i = 0; i < count; i++) {
    const timestamp = new Date(Date.UTC(2026, 6, 18, 0, 0, i)).toISOString();
    writeFileSync(
      path.join(day, `rollout-${String(i).padStart(4, "0")}.jsonl`),
      jl({
        type: "session_meta",
        payload: { id: `session-${i}`, timestamp, cwd: `/repo/${i % 3}`, model_provider: "openai" },
      }) +
        jl({ type: "event_msg", payload: { type: "user_message" } }) +
        jl({ type: "event_msg", payload: { type: "task_started" } }),
    );
  }
  return home;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bounded Codex session discovery", () => {
  it("reports exact corpus stats while keeping the session page capped at 200", async () => {
    const home = makeCodexHome(205);

    const [sessions, stats] = await Promise.all([
      listCodexSessions(home),
      getCodexStats(home),
    ]);

    expect(sessions).toHaveLength(200);
    expect(stats.totalSessions).toBe(205);
    expect(sessions[0]?.id).toBe("session-204");
    expect(sessions[0]).toMatchObject({ userMessageCount: 1, turnCount: 1 });
  });

  it("streams rollout files instead of using whole-file readFile buffering", async () => {
    const home = makeCodexHome(3);
    const readFile = vi.spyOn(fs.promises, "readFile").mockRejectedValue(
      new Error("whole-file reads are forbidden on the listing path"),
    );

    const sessions = await listCodexSessions(home);

    expect(sessions).toHaveLength(3);
    expect(readFile).not.toHaveBeenCalled();
  });
});
