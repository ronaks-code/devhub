export {}; // ensure this file is treated as a module (enables top-level await)

// Silence only the node:sqlite "experimental" notice — keep all other warnings.
// Must run BEFORE the engine (which loads node:sqlite) is imported, hence the
// dynamic import below.
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === "string" ? warning : (warning?.message ?? "");
  if (msg.includes("SQLite is an experimental")) return;
  return (_emitWarning as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { buildApp, startEngineLifecycle } = await import("./app.js");

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

const { app, engine } = buildApp();
const stop = startEngineLifecycle(engine);

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    console.log(`[devhub] server on http://${HOST}:${PORT}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stop();
    engine.close();
    void app.close().then(() => process.exit(0));
  });
}
