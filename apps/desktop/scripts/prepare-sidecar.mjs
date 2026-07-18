import { access, cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopDir, "../..");
const output = path.join(desktopDir, "dist", "sidecar");
const nodeModules = path.join(output, "node_modules");
const webDist = path.join(repoRoot, "apps", "web", "dist");

await rm(output, { recursive: true, force: true });
await mkdir(path.dirname(output), { recursive: true });

const deploy = spawnSync(
  "pnpm",
  [
    "--config.inject-workspace-packages=true",
    "--config.node-linker=hoisted",
    "--filter",
    "@devhub/server",
    "--fail-if-no-match",
    "deploy",
    "--prod",
    output,
  ],
  { cwd: repoRoot, stdio: "inherit", env: process.env },
);
if (deploy.status !== 0) {
  throw new Error(`pnpm deploy failed with status ${deploy.status ?? "unknown"}`);
}

// Legacy deploy is required for this workspace's non-injected dependencies.
// Override only this deploy's linker so Tauri receives a real, self-contained
// node_modules tree instead of a symlinked .pnpm graph that it will not bundle.

// The deployed server is a relocatable pnpm package containing its workspace
// engine dependency and tsx runtime. Keep the Vite build beside it so Fastify
// can serve UI + HTTP/SSE/WebSocket APIs from one localhost origin.
await cp(webDist, path.join(output, "web"), { recursive: true });
await Promise.all([
  assertRegularFile(path.join(nodeModules, "tsx", "dist", "cli.mjs")),
  assertRegularFile(path.join(nodeModules, "@devhub", "engine", "package.json")),
  assertRegularFile(path.join(nodeModules, "fastify", "package.json")),
  assertRegularFile(path.join(nodeModules, "@fastify", "cors", "package.json")),
  assertRegularFile(path.join(nodeModules, "@fastify", "websocket", "package.json")),
  access(path.join(output, "src", "index.ts")),
  access(path.join(output, "web", "index.html")),
]);
await assertNoSymlinks(nodeModules);

async function assertRegularFile(file) {
  const stats = await lstat(file);
  if (!stats.isFile()) {
    throw new Error(`Packaged sidecar dependency is not a regular file: ${file}`);
  }
}

async function assertNoSymlinks(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.name === ".bin") {
        // .bin holds benign relative executable shims; deps resolve via node_modules, not .bin
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Packaged sidecar dependency is still a symlink: ${candidate}`);
      }
      if (entry.isDirectory()) {
        pending.push(candidate);
      }
    }
  }
}
