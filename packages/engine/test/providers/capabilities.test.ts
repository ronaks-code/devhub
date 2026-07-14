import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_CAPABILITIES,
  ProviderCapabilityError,
  defineProviderCapabilities,
  requireProviderCapability,
} from "../../src/providers/capabilities.js";

describe("provider capabilities", () => {
  it("defines every approved capability explicitly and false by default", () => {
    expect(DEFAULT_PROVIDER_CAPABILITIES).toEqual({
      list: false,
      read: false,
      start: false,
      resume: false,
      fork: false,
      send: false,
      steer: false,
      interrupt: false,
      subscribe: false,
      approveCommand: false,
      approveFileChange: false,
      approvePermissions: false,
      requestUserInput: false,
      mcpElicitation: false,
      archive: false,
      rename: false,
      skills: false,
      plugins: false,
      hooks: false,
      mcp: false,
      backgroundWork: false,
    });
    expect(Object.isFrozen(DEFAULT_PROVIDER_CAPABILITIES)).toBe(true);
  });

  it("only enables explicit overrides and freezes the result", () => {
    const capabilities = defineProviderCapabilities({ list: true, read: true });

    expect(capabilities.list).toBe(true);
    expect(capabilities.read).toBe(true);
    expect(capabilities.start).toBe(false);
    expect(Object.isFrozen(capabilities)).toBe(true);
  });

  it("copies only named boolean capabilities across the trust boundary", () => {
    const capabilities = defineProviderCapabilities({
      list: true,
      injectedCredential: "do-not-copy",
    } as Partial<import("../../src/providers/types.js").ProviderCapabilities>);

    expect(capabilities.list).toBe(true);
    expect(capabilities).not.toHaveProperty("injectedCredential");
    expect(() => defineProviderCapabilities({ list: "yes" } as never)).toThrow(/boolean/i);
  });

  it("fails closed with a typed error when a capability is absent", () => {
    const capabilities = defineProviderCapabilities({ list: true });

    expect(() => requireProviderCapability(capabilities, "list", "openai")).not.toThrow();
    expect(() => requireProviderCapability(capabilities, "start", "openai")).toThrow(
      ProviderCapabilityError,
    );

    try {
      requireProviderCapability(capabilities, "start", "openai");
    } catch (error) {
      expect(error).toMatchObject({
        code: "PROVIDER_CAPABILITY_UNAVAILABLE",
        capability: "start",
        provider: "openai",
      });
    }
  });
});
