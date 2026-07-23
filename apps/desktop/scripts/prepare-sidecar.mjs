import { access, cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

// PERF: compile the server + engine to plain JS so the packaged sidecar runs
// `node dist/index.js` directly instead of transpiling TypeScript through `tsx` on
// every launch (a large, repeated CPU cost — the app's slow-boot culprit). The
// compiled `dist/` is what the desktop shell actually executes now.
const build = spawnSync(
  "pnpm",
  ["--filter", "@devhub/engine", "--filter", "@devhub/server", "build"],
  { cwd: repoRoot, stdio: "inherit", env: process.env },
);
if (build.status !== 0) {
  throw new Error(`sidecar TypeScript build failed with status ${build.status ?? "unknown"}`);
}

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
// engine dependency (compiled) and its runtime deps. Keep the Vite build beside it
// so Fastify can serve UI + HTTP/SSE/WebSocket APIs from one localhost origin.
await cp(webDist, path.join(output, "web"), { recursive: true });

// PERF (compiled-JS runtime): the deployed @devhub/engine keeps its dev exports
// pointing at raw `./src/*.ts`. The packaged server runs as compiled `dist/index.js`
// via `node` (no tsx), and node's TS type-stripping REFUSES .ts files under
// node_modules — so `import "@devhub/engine"` would crash. Rewrite the bundled
// engine's exports to its already-shipped compiled `./dist/*.js`. Source packages
// are untouched, so the tsx-based dev server keeps resolving `./src`.
const enginePkgPath = path.join(nodeModules, "@devhub", "engine", "package.json");
const enginePkg = JSON.parse(await readFile(enginePkgPath, "utf8"));
enginePkg.exports = {
  ".": "./dist/index.js",
  "./types": "./dist/types.js",
  "./driver": "./dist/driver/types.js",
  "./provider-status-contract": "./dist/provider-status-contract.js",
  "./providers": "./dist/providers/index.js",
};
if (enginePkg.main) enginePkg.main = "./dist/index.js";
// CRITICAL: pnpm hardlinks the deployed package.json to the SOURCE via its
// content-addressable store, so writing in place would mutate packages/engine/
// package.json too (flipping dev/test resolution to ./dist). Delete first to break
// the hardlink, then write a fresh inode — the bundled copy points at dist, source
// keeps its ./src dev exports.
await rm(enginePkgPath, { force: true });
await writeFile(enginePkgPath, JSON.stringify(enginePkg, null, 2));

await Promise.all([
  assertRegularFile(path.join(nodeModules, "@devhub", "engine", "dist", "index.js")),
  assertRegularFile(path.join(nodeModules, "fastify", "package.json")),
  assertRegularFile(path.join(nodeModules, "@fastify", "cors", "package.json")),
  assertRegularFile(path.join(nodeModules, "@fastify", "websocket", "package.json")),
  access(path.join(output, "dist", "index.js")),
  access(path.join(output, "dist", "app.js")),
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
