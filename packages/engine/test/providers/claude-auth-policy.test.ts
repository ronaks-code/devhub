import { describe, expect, it } from "vitest";
import {
  evaluateClaudeProgrammaticAuth,
  requireClaudeProgrammaticAuth,
} from "../../src/providers/claude/auth-policy.js";

describe("Claude programmatic auth policy", () => {
  it.each([
    [{ ANTHROPIC_API_KEY: "secret" }, "api-key"],
    [{ ANTHROPIC_AUTH_TOKEN: "short-lived" }, "workload-identity"],
    [{ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" }, "bedrock"],
    [{
      CLAUDE_CODE_USE_VERTEX: "true",
      ANTHROPIC_VERTEX_PROJECT_ID: "project",
      CLOUD_ML_REGION: "us-east5",
    }, "vertex"],
    [{
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_RESOURCE: "resource",
    }, "foundry"],
  ] as const)("accepts supported programmatic auth without returning credentials", (env, method) => {
    const result = evaluateClaudeProgrammaticAuth(env);
    expect(result).toEqual({ authorized: true, method });
    for (const [key, value] of Object.entries(env)) {
      if (/(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN)$/.test(key)) {
        expect(JSON.stringify(result)).not.toContain(value);
      }
    }
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects subscription OAuth and incomplete cloud flags without reflecting values", () => {
    const secret = "oauth-secret";
    expect(evaluateClaudeProgrammaticAuth({ CLAUDE_CODE_OAUTH_TOKEN: secret })).toEqual({
      authorized: false,
      method: null,
    });
    expect(evaluateClaudeProgrammaticAuth({ CLAUDE_CODE_USE_BEDROCK: "1" }).authorized).toBe(false);
    expect(evaluateClaudeProgrammaticAuth({
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "project",
    }).authorized).toBe(false);
    expect(evaluateClaudeProgrammaticAuth({
      CLAUDE_CODE_USE_FOUNDRY: "1",
    }).authorized).toBe(false);
    expect(() => requireClaudeProgrammaticAuth({ CLAUDE_CODE_OAUTH_TOKEN: secret }))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED_AUTH" }));
    try {
      requireClaudeProgrammaticAuth({ CLAUDE_CODE_OAUTH_TOKEN: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("uses exact truthy flags and rejects hostile or inherited object shapes", () => {
    expect(evaluateClaudeProgrammaticAuth({
      CLAUDE_CODE_USE_BEDROCK: "yes-please",
      AWS_REGION: "us-east-1",
    }).authorized).toBe(false);
    expect(() => evaluateClaudeProgrammaticAuth(Object.create({
      ANTHROPIC_API_KEY: "inherited",
    }))).toThrowError(expect.objectContaining({ code: "INVALID_ENVIRONMENT" }));
    expect(() => evaluateClaudeProgrammaticAuth(new Proxy({}, {
      ownKeys() { throw new Error("secret"); },
    }))).toThrowError(expect.objectContaining({ code: "INVALID_ENVIRONMENT" }));
  });

  it.each([
    {
      ANTHROPIC_API_KEY: "api-secret",
      ANTHROPIC_AUTH_TOKEN: "workload-secret",
    },
    {
      ANTHROPIC_API_KEY: "api-secret",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
    },
  ])("rejects simultaneous complete billing paths without reflecting credentials", (env) => {
    for (const classify of [evaluateClaudeProgrammaticAuth, requireClaudeProgrammaticAuth]) {
      expect(() => classify(env)).toThrowError(expect.objectContaining({
        code: "AMBIGUOUS_AUTH",
      }));
      try {
        classify(env);
      } catch (error) {
        expect(String(error)).not.toContain("api-secret");
        expect(String(error)).not.toContain("workload-secret");
      }
    }
  });
});
