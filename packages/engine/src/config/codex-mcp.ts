import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { McpServerDef, McpServerInput } from "./index.js";
import { safeWriteFile } from "./safe-write.js";

const execFileAsync = promisify(execFile);
const MCP_NAME = /^[A-Za-z0-9_-]+$/;

export type CodexMcpServerDef = McpServerDef & { enabled: boolean };
export type CodexMcpRunner = (
  executable: string,
  args: string[],
  env: { CODEX_HOME: string },
) => Promise<{ stdout: string }>;

export interface CodexMcpManager {
  list(): Promise<CodexMcpServerDef[]>;
  upsert(name: string, server: McpServerInput): Promise<void>;
  remove(name: string): Promise<void>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
}

function requireName(name: string): void {
  if (!MCP_NAME.test(name)) throw new Error("MCP server name may contain only letters, numbers, _ and -");
}

const defaultRun: CodexMcpRunner = async (executable, args, env) => {
  const result = await execFileAsync(executable, args, {
    env: { ...process.env, ...env },
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: result.stdout };
};

function normalizeList(stdout: string): CodexMcpServerDef[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error("codex mcp list returned an invalid response");
  return parsed.flatMap((value): CodexMcpServerDef[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    if (typeof row.name !== "string") return [];
    const transport = row.transport && typeof row.transport === "object" && !Array.isArray(row.transport)
      ? row.transport as Record<string, unknown>
      : {};
    const type = typeof transport.type === "string" ? transport.type : null;
    const command = typeof transport.command === "string" ? transport.command : null;
    const args = Array.isArray(transport.args)
      ? transport.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const raw: Record<string, unknown> = { ...transport };
    return [{ name: row.name, type, command, args, scope: "global", raw, enabled: row.enabled !== false }];
  });
}

function upsertEnabled(text: string, name: string, enabled: boolean): string {
  const heading = `[mcp_servers.${name}]`;
  const start = text.split("\n").findIndex((line) => line.trim() === heading);
  if (start < 0) throw new Error(`no Codex MCP server named "${name}"`);
  const lines = text.split("\n");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i]!.trimStart().startsWith("[")) { end = i; break; }
  }
  const enabledLine = lines.slice(start + 1, end).findIndex((line) => /^\s*enabled\s*=/.test(line));
  if (enabledLine >= 0) lines[start + 1 + enabledLine] = `enabled = ${enabled}`;
  else {
    let insertAt = end;
    while (insertAt > start + 1 && lines[insertAt - 1]!.trim() === "") insertAt -= 1;
    lines.splice(insertAt, 0, `enabled = ${enabled}`);
  }
  return lines.join("\n");
}

export function createCodexMcpManager(options: {
  executable: string;
  home: string;
  run?: CodexMcpRunner;
}): CodexMcpManager {
  const run = options.run ?? defaultRun;
  const invoke = (args: string[]) => run(options.executable, args, { CODEX_HOME: options.home });
  const manager: CodexMcpManager = {
    async list() {
      return normalizeList((await invoke(["mcp", "list", "--json"])).stdout);
    },
    async upsert(name: string, server: McpServerInput) {
      requireName(name);
      const type = server.type ?? "stdio";
      if (type === "stdio") {
        if (typeof server.command !== "string" || !server.command.trim()) throw new Error("stdio server requires a command");
        const envArgs = Object.entries(server.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
        await invoke(["mcp", "add", name, ...envArgs, "--", server.command, ...(server.args ?? [])]);
      } else {
        if (typeof server.url !== "string" || !server.url.trim()) throw new Error(`${type} server requires a url`);
        await invoke(["mcp", "add", name, "--url", server.url]);
      }
    },
    async remove(name: string) {
      requireName(name);
      await invoke(["mcp", "remove", name]);
    },
    async setEnabled(name: string, enabled: boolean) {
      requireName(name);
      const file = path.join(options.home, "config.toml");
      const text = await readFile(file, "utf8");
      await safeWriteFile(file, upsertEnabled(text, name, enabled));
    },
  };
  return Object.freeze(manager);
}
