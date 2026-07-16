import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveClaudeBin } from "../../src/driver/cli.js";

// resolveClaudeBin backs the chat driver's `claude` spawn (CliDriver/PersistentSession
// in src/driver/cli.ts). Before this fix the module just trusted a bare "claude"
// string to Node's own PATH lookup at spawn() time — nondeterministic and unvalidated
// (whatever happens to shadow "claude" first on process.env.PATH wins, no check that
// it's even an executable file). These tests pin the deterministic, validated
// replacement using real temp directories/files — no mocking of fs internals.

const created: string[] = [];

/** A realpath'd temp root, so an OS-level symlinked tmpdir (e.g. macOS's
 * /var -> /private/var) doesn't make an otherwise-correct absolute-path match fail. */
function tempRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "devhub-resolve-claude-bin-"));
  created.push(dir);
  return realpathSync(dir);
}

/** Write an executable (mode 0o755) file at `file`, creating parent dirs. */
function writeExecutable(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "#!/bin/sh\necho fake-claude\n");
  chmodSync(file, 0o755);
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveClaudeBin", () => {
  it("returns the explicit CLAUDE_UI_CLAUDE_BIN override as-is, unvalidated (intentional escape hatch)", () => {
    const result = resolveClaudeBin({
      env: { CLAUDE_UI_CLAUDE_BIN: "/not/a/real/path/claude", PATH: "" },
      homedir: tempRoot(),
    });
    expect(result).toBe("/not/a/real/path/claude");
  });

  it("resolves a real executable found on an absolute PATH entry to its absolute, validated path", () => {
    const root = tempRoot();
    const binDir = path.join(root, "custom-bin");
    const bin = path.join(binDir, "claude");
    writeExecutable(bin);

    const result = resolveClaudeBin({
      env: { PATH: `/does/not/exist:${binDir}`, CLAUDE_UI_CLAUDE_BIN: undefined },
      homedir: root,
      platform: "darwin",
    });
    expect(result).toBe(bin);
  });

  it("follows a symlink on PATH to the real executable (realpath, not the symlink itself)", () => {
    const root = tempRoot();
    const realDir = path.join(root, "real-bin");
    const real = path.join(realDir, "claude-real");
    writeExecutable(real);

    const linkDir = path.join(root, "link-bin");
    mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, "claude");
    symlinkSync(real, link);

    const result = resolveClaudeBin({
      env: { PATH: linkDir },
      homedir: root,
      platform: "darwin",
    });
    expect(result).toBe(real);
  });

  it("skips a non-executable file on PATH and falls through to a later valid candidate", () => {
    const root = tempRoot();
    const brokenDir = path.join(root, "broken-bin");
    const broken = path.join(brokenDir, "claude");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(broken, "not executable");
    chmodSync(broken, 0o644); // no X_OK

    const goodDir = path.join(root, "good-bin");
    const good = path.join(goodDir, "claude");
    writeExecutable(good);

    const result = resolveClaudeBin({
      env: { PATH: `${brokenDir}:${goodDir}` },
      homedir: root,
      platform: "darwin",
    });
    expect(result).toBe(good);
  });

  it("falls back to the well-known ~/.local/bin install dir when PATH has nothing", () => {
    const root = tempRoot();
    const wellKnown = path.join(root, ".local", "bin", "claude");
    writeExecutable(wellKnown);

    const result = resolveClaudeBin({
      env: { PATH: "/does/not/exist" },
      homedir: root,
      platform: "darwin",
    });
    expect(result).toBe(wellKnown);
  });

  it("falls back to the bare name only when nothing validates anywhere", () => {
    const root = tempRoot();
    const result = resolveClaudeBin({
      env: { PATH: "/does/not/exist:/also/not/real" },
      homedir: root,
      platform: "darwin",
    });
    expect(result).toBe("claude");
  });

  it("ignores relative (non-absolute) PATH entries — never trusts cwd-relative shadowing", () => {
    const root = tempRoot();
    // A relative PATH entry pointing at a real executable must NOT be trusted:
    // resolving it would depend on the spawning process's cwd, reintroducing the
    // exact ambient/nondeterministic lookup this function exists to avoid.
    const relDir = "relative-bin";
    writeExecutable(path.join(root, relDir, "claude"));

    const result = resolveClaudeBin({
      env: { PATH: relDir },
      homedir: root,
      platform: "darwin",
    });
    expect(result).toBe("claude");
  });
});
