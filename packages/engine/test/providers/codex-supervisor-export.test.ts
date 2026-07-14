import { describe, expect, it } from "vitest";
import * as providers from "../../src/providers/index.js";
import {
  CODEX_SUPERVISOR_BACKOFF_MS,
  CodexAppServerSupervisor,
  CodexSupervisorError,
  codexSupervisorBackoffDelay,
} from "../../src/providers/codex/supervisor.js";

describe("Codex supervisor public provider exports", () => {
  it("exposes the supervisor runtime through the providers barrel", () => {
    expect(providers).toMatchObject({
      CODEX_SUPERVISOR_BACKOFF_MS,
      CodexAppServerSupervisor,
      CodexSupervisorError,
      codexSupervisorBackoffDelay,
    });
  });
});
