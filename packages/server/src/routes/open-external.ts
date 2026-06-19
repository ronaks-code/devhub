/**
 * Open a project in an external app: POST /api/open { cwd, target, file? }
 *
 *   target="finder"   → reveal the folder in the OS file manager
 *   target="terminal" → open a terminal at the folder
 *   target="editor"   → open the folder in the user's editor ($EDITOR or `code`);
 *                       with an optional `file` (relative to `cwd` or absolute,
 *                       but always resolving UNDER `cwd`) it opens that specific
 *                       file instead — `code <cwd> -g <file>` / `open <file>`.
 *
 * This is the "open in…" affordance on a project card. It's best-effort: the
 * opener is launched detached and we don't wait for the GUI app — we only report
 * whether the spawn itself started. A missing binary (e.g. no `code` on PATH) is a
 * typed `{ ok:false, error }`, never a thrown 500.
 *
 * SECURITY — cwd allowlist: `cwd` MUST exactly match a known project's cwd
 * (archived included); anything else is a 400. Combined with execFile (NO shell,
 * args passed as an array), a `cwd` can never be interpreted as shell syntax or
 * point the opener at an arbitrary host directory.
 *
 * PLATFORM: macOS uses `open` (Finder), `open -a Terminal` (Terminal), and
 * `$EDITOR`/`code` (editor). Linux uses `xdg-open` / `$TERMINAL` / `$EDITOR`.
 * Windows uses `explorer` / `cmd /c start` / `$EDITOR`. The matrix lives in one
 * place ({@link resolveOpener}) so a new platform is a single edit.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Engine } from "@devhub/engine";

type OpenTarget = "editor" | "finder" | "terminal";
const TARGETS: OpenTarget[] = ["editor", "finder", "terminal"];

const openSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cwd", "target"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    target: { type: "string", enum: [...TARGETS] },
    // Optional: open this specific FILE (only meaningful for target="editor").
    // Relative paths resolve against `cwd`; absolute paths must live under `cwd`.
    file: { type: "string", minLength: 1 },
  },
} as const;

interface OpenBody {
  cwd: string;
  target: OpenTarget;
  file?: string;
}

/** The binary + args to launch for a (platform, target) pair. */
interface Opener {
  cmd: string;
  args: string[];
}

/**
 * Resolve the OS opener for a target. `cwd` is always passed as a literal arg
 * (execFile, no shell). The editor honors `$EDITOR` first, falling back to VS
 * Code's `code` CLI, which is the common case for this kind of UI.
 *
 * When `file` is given (an ABSOLUTE path already validated to live under `cwd`)
 * AND the target is "editor", open that specific file rather than the folder:
 * VS Code-style editors take `<cwd> -g <file>` (open the project, focus the file);
 * a generic `$EDITOR` / macOS `open` is just handed the file path. For non-editor
 * targets `file` is ignored (you can't "reveal a file" in a terminal).
 */
function resolveOpener(target: OpenTarget, cwd: string, file?: string): Opener {
  const editorBin = process.env.EDITOR?.trim() || "code";
  // VS Code family supports the `-g <file>` "goto" flag; a custom $EDITOR may not,
  // so only use it for the `code` default and fall back to a bare file arg otherwise.
  const isVsCode = editorBin === "code";
  const editorArgs = (): string[] => {
    if (!file) return [cwd];
    return isVsCode ? [cwd, "-g", file] : [file];
  };

  if (process.platform === "darwin") {
    switch (target) {
      case "finder":
        return { cmd: "open", args: [cwd] };
      case "terminal":
        return { cmd: "open", args: ["-a", "Terminal", cwd] };
      case "editor":
        return { cmd: editorBin, args: editorArgs() };
    }
  }

  if (process.platform === "win32") {
    switch (target) {
      case "finder":
        return { cmd: "explorer", args: [cwd] };
      case "terminal":
        // `cmd /c start` opens a new console window at `cwd`.
        return { cmd: "cmd", args: ["/c", "start", "cmd", "/k", "cd", "/d", cwd] };
      case "editor":
        return { cmd: editorBin, args: editorArgs() };
    }
  }

  // Linux / other POSIX.
  switch (target) {
    case "finder":
      return { cmd: "xdg-open", args: [cwd] };
    case "terminal":
      // Honor $TERMINAL, else x-terminal-emulator (Debian alternatives system).
      return {
        cmd: process.env.TERMINAL?.trim() || "x-terminal-emulator",
        args: ["--working-directory", cwd],
      };
    case "editor":
      return { cmd: editorBin, args: editorArgs() };
  }
}

/**
 * Resolve a caller-supplied `file` (relative to `cwd`, or absolute) to an absolute
 * path and verify it lives UNDER `cwd`. Returns the resolved absolute path, or null
 * when it escapes `cwd` (`..` traversal / a sibling dir / an absolute path elsewhere).
 * Mirrors the cwd allowlist: a `file` can never point the opener outside the project.
 */
function resolveFileWithinCwd(cwd: string, file: string): string | null {
  const baseDir = path.resolve(cwd);
  const resolved = path.resolve(baseDir, file);
  const rel = path.relative(baseDir, resolved);
  // `rel` starting with ".." (or being absolute on a different drive) means the
  // target escaped `cwd`. An empty `rel` means `file` resolved to `cwd` itself.
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

/**
 * Launch the opener detached. Best-effort: resolves `{ ok:true }` once the spawn
 * begins, or `{ ok:false, error }` if the binary can't be found / fails to start.
 * We don't wait for the GUI app — `unref()` lets the launcher exit without keeping
 * the server alive.
 */
function launch(opener: Opener, cwd: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      opener.cmd,
      opener.args,
      { cwd, timeout: 10_000, windowsHide: true },
      (err) => {
        if (err) {
          const notFound = (err as NodeJS.ErrnoException).code === "ENOENT";
          resolve({
            ok: false,
            error: notFound
              ? `${opener.cmd} not found`
              : err.message.trim() || `failed to open ${opener.cmd}`,
          });
        }
      },
    );
    child.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });
    // A GUI opener that detaches cleanly returns immediately; treat a successful
    // spawn (process has a pid) as ok without blocking on the callback.
    if (child.pid) {
      child.unref();
      resolve({ ok: true });
    }
  });
}

/** Wire POST /api/open onto an app, backed by the engine for the cwd allowlist. */
export function registerOpenExternalRoutes(app: FastifyInstance, engine: Engine): void {
  /** True when `cwd` is a known project path (archived projects included). */
  const isKnownCwd = (cwd: string): boolean =>
    engine.getProjects({ includeArchived: true }).some((p) => p.cwd === cwd);

  app.post<{ Body: OpenBody }>(
    "/api/open",
    { schema: { body: openSchema } },
    async (req, reply) => {
      const { cwd, target, file } = req.body;
      if (!isKnownCwd(cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }

      // An optional `file` must resolve UNDER the (already-allowlisted) cwd. We
      // resolve it for any target so a bad path is rejected up front, but it only
      // changes behavior for target="editor" (you can't open a file in a terminal).
      let resolvedFile: string | undefined;
      if (file !== undefined) {
        const r = resolveFileWithinCwd(cwd, file);
        if (!r) return reply.code(400).send({ error: "file escapes cwd" });
        resolvedFile = r;
      }

      const opener = resolveOpener(target, cwd, target === "editor" ? resolvedFile : undefined);
      const result = await launch(opener, cwd);
      if (!result.ok) {
        // Best-effort: a failed launch is a 502 with the reason, not a crash.
        return reply.code(502).send({ ok: false, error: result.error ?? "failed to open" });
      }
      return { ok: true, target, cmd: opener.cmd, file: resolvedFile ?? null };
    },
  );
}
