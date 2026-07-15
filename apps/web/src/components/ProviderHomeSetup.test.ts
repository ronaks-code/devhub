import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderCapabilities } from "../lib/provider-api.js";
import {
  createProviderIndexApiClient,
  type ProviderIndexApiClient,
  type PublicProviderHome,
} from "../lib/provider-index-api.js";
import {
  CodexNativeDirectPane,
  CodexNativePane,
  type CodexNativePaneProps,
} from "./CodexNativePane.js";
import {
  ProviderHomePicker,
  ProviderHomeSetup,
  availableProviderHomes,
  discoverProviderHomes,
  providerHomeCapabilitySummary,
  shortHomeFingerprint,
} from "./ProviderHomeSetup.js";

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);
const RAW_HOME = "/Users/test/.codex";

// A raw home should never appear anywhere in a flag-on surface. This is the exact
// substring set the DOM/request assertions scan for.
const RAW_HOME_MARKERS = ["/Users/", "/home/", ".codex", ".claude", RAW_HOME];

function caps(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  const keys = [
    "list", "read", "start", "resume", "fork", "send", "steer", "interrupt",
    "subscribe", "approveCommand", "approveFileChange", "approvePermissions",
    "requestUserInput", "mcpElicitation", "archive", "rename", "skills", "plugins",
    "hooks", "mcp", "backgroundWork",
  ] as const;
  const base = Object.fromEntries(keys.map((key) => [key, false])) as unknown as ProviderCapabilities;
  return { ...base, ...overrides };
}

function home(overrides: Partial<PublicProviderHome> = {}): PublicProviderHome {
  return {
    provider: "openai",
    homeFingerprint: FP_A,
    status: "available",
    capabilities: caps({ list: true, read: true, start: true, resume: true, send: true }),
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProviderHomeSetup transport selection by flag state", () => {
  it("renders the direct fallback (never the indexed setup) unless the flag is applied true", () => {
    const fallback = createElement("div", null, "LEGACY-DIRECT");
    for (const features of [undefined, {}, { unifiedTaskIndex: false }] as const) {
      const html = renderToStaticMarkup(
        createElement(ProviderHomeSetup, { features, fallback }),
      );
      expect(html).toContain("LEGACY-DIRECT");
      expect(html).not.toContain("Discovering native");
    }
  });

  it("selects the indexed facade setup when the flag is applied true", () => {
    const homes = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ProviderHomeSetup, {
        features: { unifiedTaskIndex: true },
        indexedClient: { homes } as unknown as ProviderIndexApiClient,
      }),
    );
    // Effects do not run under static rendering, so the initial paint is the bounded
    // loading state and no discovery request has fired yet (kept hermetic).
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Discovering native Codex homes");
    expect(homes).not.toHaveBeenCalled();
  });
});

describe("discoverProviderHomes facade wiring (path-free)", () => {
  it("consumes only homes() and preselects the preferred fingerprint when still available", async () => {
    const homes = vi.fn().mockResolvedValue([
      home({ homeFingerprint: FP_B }),
      home({ homeFingerprint: FP_A }),
      home({ provider: "anthropic", homeFingerprint: "c".repeat(64) }),
      home({ homeFingerprint: "d".repeat(64), status: "unavailable", capabilities: null }),
    ]);
    const client = { homes } as unknown as ProviderIndexApiClient;

    const discovery = await discoverProviderHomes(client, "openai", FP_B);
    expect(homes).toHaveBeenCalledTimes(1);
    // openai + available + list/read only, sorted by fingerprint, no raw home in play.
    expect(discovery.homes.map((h) => h.homeFingerprint)).toEqual([FP_A, FP_B]);
    expect(discovery.selectedFingerprint).toBe(FP_B);
    for (const h of discovery.homes) {
      expect(Object.keys(h)).not.toContain("home");
      expect(JSON.stringify(h)).not.toContain("/");
    }
  });

  it("falls back to the first eligible home when no preferred fingerprint matches", async () => {
    const homes = vi.fn().mockResolvedValue([home({ homeFingerprint: FP_B }), home({ homeFingerprint: FP_A })]);
    const discovery = await discoverProviderHomes(
      { homes } as unknown as ProviderIndexApiClient,
      "openai",
      "z".repeat(64),
    );
    expect(discovery.selectedFingerprint).toBe(FP_A);
  });

  it("issues a path-free homes() request (GET, no body, no raw home) over the real facade", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = createProviderIndexApiClient();

    await discoverProviderHomes(client, "openai");
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/api/provider-index/homes");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    for (const marker of RAW_HOME_MARKERS) {
      expect(url).not.toContain(marker);
      expect(String(init.body ?? "")).not.toContain(marker);
    }
  });
});

describe("ProviderHomePicker flag-on DOM is fingerprint-only", () => {
  it("renders fingerprints + capabilities and never a raw home or NUL byte", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderHomePicker, {
        homes: [home({ homeFingerprint: FP_A }), home({ homeFingerprint: FP_B })],
        selectedFingerprint: FP_A,
        onSelect: () => undefined,
        label: "OpenAI · Codex",
        product: "Codex",
      }),
    );
    expect(html).toContain(shortHomeFingerprint(FP_A));
    expect(html).toContain("list · read · start · resume · send");
    expect(html).not.toContain("\u0000");
    for (const marker of RAW_HOME_MARKERS) expect(html).not.toContain(marker);
  });

  it("shows a single fingerprint (no select) when exactly one home is available", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderHomePicker, {
        homes: [home({ homeFingerprint: FP_A })],
        selectedFingerprint: FP_A,
        onSelect: () => undefined,
        label: "Anthropic · Claude",
        product: "Claude",
      }),
    );
    expect(html).not.toContain("<select");
    expect(html).toContain(shortHomeFingerprint(FP_A));
    for (const marker of RAW_HOME_MARKERS) expect(html).not.toContain(marker);
  });
});

describe("pure home helpers", () => {
  it("keeps only same-provider verified-available list+read homes, sorted by fingerprint", () => {
    const eligible = availableProviderHomes(
      [
        home({ homeFingerprint: FP_B }),
        home({ homeFingerprint: FP_A }),
        home({ homeFingerprint: "e".repeat(64), capabilities: caps({ list: true }) }), // no read
        home({ provider: "anthropic", homeFingerprint: "f".repeat(64) }),
      ],
      "openai",
    );
    expect(eligible.map((h) => h.homeFingerprint)).toEqual([FP_A, FP_B]);
  });

  it("summarizes only enabled summary capabilities, path-free", () => {
    expect(providerHomeCapabilitySummary(home({ capabilities: caps({ list: true, read: true }) })))
      .toBe("list · read");
    expect(providerHomeCapabilitySummary(home({ capabilities: null }))).toBe(
      "no verified capabilities",
    );
  });

  it("truncates long fingerprints for display and leaves short ones intact", () => {
    expect(shortHomeFingerprint(FP_A)).toBe(`${"a".repeat(12)}…`);
    expect(shortHomeFingerprint("abc")).toBe("abc");
  });
});

describe("CodexNativePane flag gate preserves the direct route byte-for-byte", () => {
  const directProps: CodexNativePaneProps = {
    client: { providers: vi.fn() } as unknown as CodexNativePaneProps["client"],
  };

  it("flag-off (and undefined) renders the direct pane with identical markup", () => {
    const wrapperOff = renderToStaticMarkup(
      createElement(CodexNativePane, { ...directProps, features: { unifiedTaskIndex: false } }),
    );
    const wrapperUndefined = renderToStaticMarkup(createElement(CodexNativePane, directProps));
    const direct = renderToStaticMarkup(createElement(CodexNativeDirectPane, directProps));

    expect(wrapperOff).toBe(direct);
    expect(wrapperUndefined).toBe(direct);
    expect(wrapperOff).toContain("Checking native Codex runtime");
    expect(wrapperOff).not.toContain("Discovering native");
  });

  it("flag-on swaps to the PublicProviderHome-only setup instead of the direct pane", () => {
    const providers = vi.fn();
    const html = renderToStaticMarkup(
      createElement(CodexNativePane, {
        client: { providers } as unknown as CodexNativePaneProps["client"],
        features: { unifiedTaskIndex: true },
      }),
    );
    expect(html).toContain("Discovering native Codex homes");
    expect(html).not.toContain("Checking native Codex runtime");
    expect(providers).not.toHaveBeenCalled();
  });
});
