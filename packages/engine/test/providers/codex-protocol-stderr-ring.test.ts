import { describe, expect, it } from "vitest";
import {
  CODEX_DEFAULT_STDERR_RING_BYTES,
  RedactedCodexStderrRing,
} from "../../src/providers/codex/protocol/index.js";

describe("redacted newest-data Codex stderr ring", () => {
  it("defaults to a four MiB byte bound", () => {
    expect(CODEX_DEFAULT_STDERR_RING_BYTES).toBe(4 * 1024 * 1024);
    expect(new RedactedCodexStderrRing().maxBytes).toBe(CODEX_DEFAULT_STDERR_RING_BYTES);
  });

  it("drops oldest complete output while retaining the newest data within its byte bound", () => {
    const ring = new RedactedCodexStderrRing({ maxBytes: 12 });
    ring.append("old\n");
    ring.append("newest\n");
    ring.append("tail\n");

    expect(ring.byteLength).toBeLessThanOrEqual(12);
    expect(ring.snapshot()).toContain("tail\n");
    expect(ring.snapshot()).not.toContain("old\n");
  });

  it("reassembles split UTF-8 without replacement characters or broken code points", () => {
    const ring = new RedactedCodexStderrRing({ maxBytes: 12 });
    const bytes = Buffer.from("🔥 ready\n", "utf8");
    ring.append(bytes.subarray(0, 2));
    expect(ring.snapshot()).toBe("");

    ring.append(bytes.subarray(2));
    expect(ring.snapshot()).toBe("🔥 ready\n");
    expect(ring.snapshot()).not.toContain("�");
    expect(ring.byteLength).toBe(Buffer.byteLength("🔥 ready\n"));
  });

  it("redacts environment secrets and bearer tokens split across input chunks", () => {
    const ring = new RedactedCodexStderrRing({ maxBytes: 1024 });
    ring.append("startup OPENAI_API_");
    ring.append("KEY=sk-test-secret-value\nauthorization: Bearer split-");
    ring.append("token-value\nhealthy\n");

    const snapshot = ring.snapshot();
    expect(snapshot).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(snapshot).toContain("authorization: [REDACTED]");
    expect(snapshot).toContain("healthy\n");
    expect(snapshot).not.toContain("sk-test-secret-value");
    expect(snapshot).not.toContain("split-token-value");
  });

  it.each([
    { input: "TOKEN=bare-token-value\n", secret: "bare-token-value" },
    { input: "SECRET: bare-secret-value\n", secret: "bare-secret-value" },
    { input: "PASSWORD=bare-password-value\n", secret: "bare-password-value" },
    { input: "KEY: bare-key-value\n", secret: "bare-key-value" },
    { input: '{"KEY":"json-key-value"}\n', secret: "json-key-value" },
    { input: '{"TOKEN":"json-token-value"}\n', secret: "json-token-value" },
    { input: '{"SECRET":"json-secret-value"}\n', secret: "json-secret-value" },
    { input: '{"PASSWORD":"json-password-value"}\n', secret: "json-password-value" },
    { input: "GET /?KEY=query-key-value&ok=1\n", secret: "query-key-value" },
    { input: "GET /?TOKEN=query-token-value&ok=1\n", secret: "query-token-value" },
    { input: "GET /?SECRET=query-secret-value&ok=1\n", secret: "query-secret-value" },
    { input: "GET /?PASSWORD=query-password-value&ok=1\n", secret: "query-password-value" },
  ])("redacts a bare-name assignment variant: $input", ({ input, secret }) => {
    const ring = new RedactedCodexStderrRing({ maxBytes: 1024 });
    ring.append(input);

    expect(ring.snapshot()).toContain("[REDACTED]");
    expect(ring.snapshot()).not.toContain(secret);
  });

  it("redacts bare secret names split across chunks before and after delimiters", () => {
    const ring = new RedactedCodexStderrRing({ maxBytes: 1024 });
    ring.append("TO");
    ring.append("KEN=split-bare-token\nSEC");
    ring.append("RET: split-bare-secret\n{\"PASS");
    ring.append("WORD\":\"split-json-password\"}\nGET /?K");
    ring.append("EY=split-query-key&ok=1\n");

    const snapshot = ring.snapshot();
    expect(snapshot.match(/\[REDACTED\]/g)).toHaveLength(4);
    for (const secret of [
      "split-bare-token",
      "split-bare-secret",
      "split-json-password",
      "split-query-key",
    ]) {
      expect(snapshot).not.toContain(secret);
    }
  });

  it.each([
    { input: 'TOKEN="quoted-token-value"\n', secret: "quoted-token-value" },
    { input: "SECRET: 'quoted-secret-value'\n", secret: "quoted-secret-value" },
    { input: "PASSWORD=`quoted-password-value`\n", secret: "quoted-password-value" },
    { input: 'KEY: "quoted-key-value"\n', secret: "quoted-key-value" },
  ])("redacts quoted bare assignments: $input", ({ input, secret }) => {
    const ring = new RedactedCodexStderrRing({ maxBytes: 1024 });
    ring.append(input);

    expect(ring.snapshot()).toContain("[REDACTED]");
    expect(ring.snapshot()).not.toContain(secret);
  });

  it("redacts a quoted bare assignment split across chunks", () => {
    const ring = new RedactedCodexStderrRing({ maxBytes: 1024 });
    ring.append("TOK");
    ring.append('EN="split-quoted-');
    ring.append('token"\n');

    expect(ring.snapshot()).toContain("TOKEN=[REDACTED]");
    expect(ring.snapshot()).not.toContain("split-quoted-token");
  });

  it("redacts authorization and cookie headers completely, including split chunks", () => {
    const ring = new RedactedCodexStderrRing({ maxBytes: 1024 });
    ring.append("Authorization: Bas");
    ring.append("ic dXNlcjpwYXNz\nProxy-Authorization: Custom top-secret\nCook");
    ring.append("ie: session=super-secret; theme=dark\nSet-Cookie: refresh=hidden; HttpOnly\n");

    const snapshot = ring.snapshot();
    expect(snapshot.match(/\[REDACTED\]/g)).toHaveLength(4);
    for (const secret of [
      "dXNlcjpwYXNz",
      "top-secret",
      "super-secret",
      "theme=dark",
      "refresh=hidden",
    ]) {
      expect(snapshot).not.toContain(secret);
    }
  });

  it("redacts structured JSON authorization and cookie fields", () => {
    const ring = new RedactedCodexStderrRing({ maxBytes: 2048 });
    ring.append('{"Author');
    ring.append('ization":"Bearer json-auth-');
    ring.append('secret"}\n{"Proxy-Authorization":"Basic json-proxy-');
    ring.append('secret"}\n{"Cook');
    ring.append('ie":"session=json-cookie-secret; theme=dark"}\n');
    ring.append('{"Set-Cookie":"refresh=json-set-cookie-');
    ring.append('secret; HttpOnly"}\n');

    const snapshot = ring.snapshot();
    expect(snapshot.match(/\[REDACTED\]/g)).toHaveLength(4);
    for (const secret of [
      "json-auth-secret",
      "json-proxy-secret",
      "json-cookie-secret",
      "theme=dark",
      "json-set-cookie-secret",
    ]) {
      expect(snapshot).not.toContain(secret);
    }
  });

  it("redacts quoted authorization and cookie assignment forms", () => {
    const ring = new RedactedCodexStderrRing({ maxBytes: 2048 });
    ring.append('Authorization="Bearer assignment-auth-secret"\n');
    ring.append("Proxy-Authorization='Basic assignment-proxy-secret'\n");
    ring.append("Cookie=`session=assignment-cookie-secret; theme=dark`\n");
    ring.append('Set-Cookie="refresh=assignment-set-cookie-secret; HttpOnly"\n');

    const snapshot = ring.snapshot();
    expect(snapshot.match(/\[REDACTED\]/g)).toHaveLength(4);
    for (const secret of [
      "assignment-auth-secret",
      "assignment-proxy-secret",
      "assignment-cookie-secret",
      "theme=dark",
      "assignment-set-cookie-secret",
    ]) {
      expect(snapshot).not.toContain(secret);
    }
  });

  it("bounds retained segment count under a newline and very-short-line flood", () => {
    const ring = new RedactedCodexStderrRing({ maxBytes: 4096 });
    ring.append("\n".repeat(50_000));
    ring.append("x\n".repeat(50_000));

    expect(ring.byteLength).toBeLessThanOrEqual(4096);
    expect(ring.retainedSegments).toBeLessThanOrEqual(4);
    expect(ring.snapshot()).toMatch(/x\n$/);
  });

  it("never retains an oversized complete-line backing allocation through a suffix view", () => {
    const maxBytes = 4096;
    const ring = new RedactedCodexStderrRing({ maxBytes });
    ring.append(`${"x".repeat(2 * 1024 * 1024)}\n`);

    expect(ring.byteLength).toBeLessThanOrEqual(maxBytes);
    expect(ring.retainedCapacityBytes).toBeLessThanOrEqual(maxBytes * 2);
    expect(ring.retainedCapacityBytes).toBeLessThan(2 * 1024 * 1024);
    expect(ring.snapshot()).toMatch(/x\n$/);
  });

  it("fails closed for a single unterminated stderr line larger than the ring", () => {
    const ring = new RedactedCodexStderrRing({ maxBytes: 32 });
    ring.append("OPENAI_API_KEY=secret-that-is-far-too-long");
    ring.append("-and-keeps-going");

    expect(ring.byteLength).toBeLessThanOrEqual(32);
    expect(ring.snapshot()).toMatch(/redacted|omitted/i);
    expect(ring.snapshot()).not.toContain("secret-that-is-far-too-long");

    ring.append("\nrecovered\n");
    expect(ring.snapshot()).toContain("recovered\n");
  });
});
