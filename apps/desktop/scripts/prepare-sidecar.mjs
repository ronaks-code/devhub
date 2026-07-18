import { access, cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopDir, "../..");
const output = path.join(desktopDir, "dist", "sidecar");
const webDist = path.join(repoRoot, "apps", "web", "dist");

await rm(output, { recursive: true, force: true });
await mkdir(path.dirname(output), { recursive: true });

const deploy = spawnSync(
  "pnpm",
  ["--filter", "@devhub/server", "--fail-if-no-match", "deploy", "--legacy", "--prod", output],
  { cwd: repoRoot, stdio: "inherit", env: process.env },
);
if (deploy.status !== 0) {
  throw new Error(`pnpm deploy failed with status ${deploy.status ?? "unknown"}`);
}

// The deployed server is a relocatable pnpm package containing its workspace
// engine dependency and tsx runtime. Keep the Vite build beside it so Fastify
// can serve UI + HTTP/SSE/WebSocket APIs from one localhost origin.
await cp(webDist, path.join(output, "web"), { recursive: true });
await Promise.all([
  access(path.join(output, "node_modules", "tsx", "dist", "cli.mjs")),
  access(path.join(output, "src", "index.ts")),
  access(path.join(output, "web", "index.html")),
]);
