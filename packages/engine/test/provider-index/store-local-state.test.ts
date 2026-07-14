import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
  addProviderIndexGenerationEpoch,
  createProviderIndexSchema,
} from "../../src/provider-index/schema.js";
import type { ProviderTaskLocator } from "../../src/provider-index/identity.js";
import { serializeTaskLocator } from "../../src/provider-index/identity.js";
import {
  classifyLegacySession,
  linkProviderFork,
  listProviderForkLinks,
  mapVerifiedLegacySession,
  patchProviderTaskMeta,
  PROVIDER_FORK_LINKS_PER_LOCATOR_LIMIT,
  providerLocalStateFailureCode,
  readProviderTaskMeta,
  type ProviderRegisteredHomeAuthority,
} from "../../src/provider-index/store-local-state.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type TestDatabase = InstanceType<typeof DatabaseSync>;

const HOME_FINGERPRINT = "1".repeat(64);

function openDatabase(): TestDatabase {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  createProviderIndexSchema(db);
  addProviderIndexGenerationEpoch(db);
  return db;
}

function locator(nativeTaskId = "task-local-state"): ProviderTaskLocator {
  return Object.freeze({
    version: 1,
    provider: "openai",
    homeFingerprint: HOME_FINGERPRINT,
    nativeTaskId,
  });
}

function scopedLocator(
  provider: "openai" | "anthropic",
  nativeTaskId: string,
  fingerprint = HOME_FINGERPRINT,
): ProviderTaskLocator {
  return Object.freeze({
    version: 1,
    provider,
    homeFingerprint: fingerprint,
    nativeTaskId,
  });
}

function expectLocalFailure(
  operation: () => unknown,
  code: ReturnType<typeof providerLocalStateFailureCode>,
): void {
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(providerLocalStateFailureCode(failure)).toBe(code);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).not.toContain(HOME_FINGERPRINT);
}

function registerAuthority(
  db: TestDatabase,
  target: ProviderTaskLocator,
  canonicalHome = `/tmp/provider-${target.provider}-${target.nativeTaskId.replaceAll("/", "-")}`,
  registeredAt = 1,
): ProviderRegisteredHomeAuthority {
  db.prepare(`INSERT INTO provider_homes (
    provider, home_fingerprint, canonical_home, registered_at
  ) VALUES (?, ?, ?, ?)`)
    .run(target.provider, target.homeFingerprint, canonicalHome, registeredAt);
  return Object.freeze({
    provider: target.provider,
    homeFingerprint: target.homeFingerprint,
    canonicalHome,
    registeredAt,
  });
}

describe("provider index local metadata", () => {
  it("synthesizes a deeply frozen default without inserting a row", () => {
    const db = openDatabase();
    const target = locator();

    const metadata = readProviderTaskMeta(db, target, 16);

    expect(metadata).toEqual({
      locator: target,
      favorite: false,
      pinned: false,
      localLabel: null,
      tags: [],
      notes: null,
      localArchived: false,
      uiState: {},
      unsupportedLocal: {},
      updatedAt: null,
    });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.locator)).toBe(true);
    expect(Object.isFrozen(metadata.tags)).toBe(true);
    expect(Object.isFrozen(metadata.uiState)).toBe(true);
    expect(Object.isFrozen(metadata.unsupportedLocal)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM provider_task_meta").get())
      .toEqual({ count: 0 });
    db.close();
  });

  it("replaces supplied local fields, preserves omitted fields, and returns frozen snapshots", () => {
    const db = openDatabase();
    const target = locator("task-patch");

    const initial = patchProviderTaskMeta(db, target, {
      favorite: true,
      pinned: true,
      localLabel: "Local label",
      tags: ["ordered", "tags"],
      notes: "Local notes",
      localArchived: true,
      uiState: { panel: { width: 320 }, tabs: ["one", "two"] },
      unsupportedLocal: { plugin: { enabled: true } },
    }, 100, 16);
    const replaced = patchProviderTaskMeta(db, target, {
      favorite: false,
      tags: ["replacement"],
      uiState: { panel: { width: 640 } },
    }, 200, 16);

    expect(initial.updatedAt).toBe(100);
    expect(replaced).toEqual({
      locator: target,
      favorite: false,
      pinned: true,
      localLabel: "Local label",
      tags: ["replacement"],
      notes: "Local notes",
      localArchived: true,
      uiState: { panel: { width: 640 } },
      unsupportedLocal: { plugin: { enabled: true } },
      updatedAt: 200,
    });
    expect(Object.isFrozen(replaced)).toBe(true);
    expect(Object.isFrozen(replaced.tags)).toBe(true);
    expect(Object.isFrozen(replaced.uiState)).toBe(true);
    expect(Object.isFrozen(replaced.uiState.panel)).toBe(true);
    expect(Object.isFrozen(replaced.unsupportedLocal.plugin)).toBe(true);
    expect(readProviderTaskMeta(db, target, 16)).toEqual(replaced);
    expect(db.prepare(`SELECT tags_json, ui_state_json, unsupported_local_json, updated_at
      FROM provider_task_meta`).get()).toEqual({
      tags_json: '["replacement"]',
      ui_state_json: '{"panel":{"width":640}}',
      unsupported_local_json: '{"plugin":{"enabled":true}}',
      updated_at: 200,
    });
    db.close();
  });

  it("works for orphan locators inside a caller transaction and remains caller-rollbackable", () => {
    const db = openDatabase();
    const target = locator("task-caller-transaction");
    db.exec("BEGIN");

    patchProviderTaskMeta(db, target, { favorite: true }, 300, 16);
    expect(readProviderTaskMeta(db, target, 16).favorite).toBe(true);
    db.exec("ROLLBACK");

    expect(readProviderTaskMeta(db, target, 16).favorite).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS count FROM provider_task_meta").get())
      .toEqual({ count: 0 });
    db.close();
  });

  it("rejects empty, inexact, accessor, proxy, and exotic patch envelopes without writes", () => {
    const db = openDatabase();
    const target = locator("task-hostile-patch");
    let getterCalls = 0;
    let proxyCalls = 0;
    const accessor = Object.defineProperty({}, "favorite", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return true;
      },
    });
    const proxy = new Proxy({ favorite: true }, {
      ownKeys: () => {
        proxyCalls += 1;
        return ["favorite"];
      },
    });
    const inherited = Object.create({ favorite: true }) as { favorite: boolean };

    for (const patch of [
      {},
      { favorite: undefined },
      { favorite: true, extra: false },
      accessor,
      proxy,
      inherited,
      [true],
      new Date(),
    ]) {
      expectLocalFailure(
        () => patchProviderTaskMeta(db, target, patch as never, 400, 16),
        "INVALID_INPUT",
      );
    }
    expect(getterCalls).toBe(0);
    expect(proxyCalls).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM provider_task_meta").get())
      .toEqual({ count: 0 });
    db.close();
  });

  it("enforces dense unique ordered tag bounds without retaining caller aliases", () => {
    const db = openDatabase();
    const target = locator("task-tags");
    const tags = ["first", "second"];
    const metadata = patchProviderTaskMeta(db, target, { tags }, 500, 16);
    tags[0] = "mutated";
    expect(metadata.tags).toEqual(["first", "second"]);

    const sparse = new Array<string>(2);
    sparse[1] = "present";
    for (const invalid of [
      [],
      ["duplicate", "duplicate"],
      [""],
      ["x".repeat(513)],
      Array.from({ length: 257 }, (_, index) => `tag-${index}`),
      sparse,
    ]) {
      if (invalid.length === 0) {
        expect(patchProviderTaskMeta(db, target, { tags: invalid }, 501, 16).tags).toEqual([]);
      } else {
        expectLocalFailure(
          () => patchProviderTaskMeta(db, target, { tags: invalid }, 501, 16),
          "INVALID_INPUT",
        );
      }
    }
    expect(readProviderTaskMeta(db, target, 16).tags).toEqual([]);
    db.close();
  });

  it("enforces prototype-safe JSON depth, aggregate-key, cycle, and exact UTF-8 budgets", () => {
    const db = openDatabase();
    const target = locator("task-json-bounds");
    const exactBytes = { x: "a".repeat(65_528) };
    expect(Buffer.byteLength(JSON.stringify(exactBytes), "utf8")).toBe(65_536);
    expect(patchProviderTaskMeta(db, target, { uiState: exactBytes }, 600, 16).uiState)
      .toEqual(exactBytes);
    expectLocalFailure(
      () => patchProviderTaskMeta(db, target, {
        uiState: { x: `${exactBytes.x}a` },
      }, 601, 16),
      "INVALID_INPUT",
    );

    const keys32 = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [
      `key-${index}`,
      index,
    ]));
    expect(patchProviderTaskMeta(db, target, { unsupportedLocal: keys32 }, 602, 16)
      .unsupportedLocal).toEqual(keys32);
    expectLocalFailure(
      () => patchProviderTaskMeta(db, target, {
        unsupportedLocal: { ...keys32, overflow: true },
      }, 603, 16),
      "INVALID_INPUT",
    );

    const depth2 = { child: { child: {} } };
    expect(patchProviderTaskMeta(db, target, { uiState: depth2 }, 604, 2).uiState)
      .toEqual(depth2);
    expectLocalFailure(
      () => patchProviderTaskMeta(db, target, {
        uiState: { child: depth2 },
      }, 605, 2),
      "INVALID_INPUT",
    );

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const nestedAccessor = { safe: true };
    Object.defineProperty(nestedAccessor, "secret", { enumerable: true, get: () => "no" });
    for (const invalid of [
      cycle,
      nestedAccessor,
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: undefined },
      { value: 1n },
      [],
    ]) {
      expectLocalFailure(
        () => patchProviderTaskMeta(db, target, { uiState: invalid as never }, 606, 16),
        "INVALID_INPUT",
      );
    }
    db.close();
  });

  it("rejects compact alias DAG expansion within a representation-derived visit budget", () => {
    const db = openDatabase();
    const target = locator("task-json-dag-budget");
    const maximumFittingItems = 32_765;
    const fitting = { "": Array.from({ length: maximumFittingItems }, () => 0) };
    expect(Buffer.byteLength(JSON.stringify(fitting), "utf8")).toBe(65_536);
    expect(patchProviderTaskMeta(db, target, { uiState: fitting }, 650, 16).uiState)
      .toEqual(fitting);

    const shared = Array.from({ length: 400 }, () => 0);
    const compactDag = { items: Array.from({ length: 400 }, () => shared) };
    const originalDescriptor = Object.getOwnPropertyDescriptor;
    let sharedItemDescriptorReads = 0;
    const descriptorSpy = vi.spyOn(Object, "getOwnPropertyDescriptor")
      .mockImplementation((value, key) => {
        if (value === shared && key !== "length") sharedItemDescriptorReads += 1;
        return originalDescriptor(value, key);
      });
    try {
      expectLocalFailure(
        () => patchProviderTaskMeta(db, target, { unsupportedLocal: compactDag }, 651, 16),
        "INVALID_INPUT",
      );
    } finally {
      descriptorSpy.mockRestore();
    }
    expect(sharedItemDescriptorReads).toBeLessThanOrEqual(maximumFittingItems);
    db.close();
  });

  it("classifies noncanonical persisted JSON as corruption", () => {
    const db = openDatabase();
    const target = locator("task-corrupt-meta");
    db.prepare(`INSERT INTO provider_task_meta (
      provider, home_fingerprint, native_task_id, tags_json,
      ui_state_json, unsupported_local_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        target.provider,
        target.homeFingerprint,
        target.nativeTaskId,
        '["duplicate","duplicate"]',
        '{ "not":"canonical" }',
        "{}",
        1,
      );

    expectLocalFailure(() => readProviderTaskMeta(db, target, 16), "CORRUPT_ROW");
    expectLocalFailure(
      () => patchProviderTaskMeta(db, target, { favorite: true }, 700, 16),
      "CORRUPT_ROW",
    );
    db.close();
  });

  it("rolls back metadata writes suppressed, deleted, or validly rewritten by triggers", () => {
    for (const action of ["ignore", "delete", "rewrite"] as const) {
      const db = openDatabase();
      const target = locator(`task-trigger-${action}`);
      const trigger = action === "ignore"
        ? `CREATE TRIGGER local_meta_trigger BEFORE INSERT ON provider_task_meta
           BEGIN SELECT RAISE(IGNORE); END`
        : action === "delete"
          ? `CREATE TRIGGER local_meta_trigger AFTER INSERT ON provider_task_meta
             BEGIN DELETE FROM provider_task_meta
               WHERE provider = NEW.provider
                 AND home_fingerprint = NEW.home_fingerprint
                 AND native_task_id = NEW.native_task_id; END`
          : `CREATE TRIGGER local_meta_trigger AFTER INSERT ON provider_task_meta
             BEGIN UPDATE provider_task_meta SET favorite = 0
               WHERE provider = NEW.provider
                 AND home_fingerprint = NEW.home_fingerprint
                 AND native_task_id = NEW.native_task_id; END`;
      db.exec(trigger);

      expectLocalFailure(
        () => patchProviderTaskMeta(db, target, { favorite: true }, 800, 16),
        "CORRUPT_ROW",
      );
      expect(db.prepare("SELECT COUNT(*) AS count FROM provider_task_meta").get())
        .toEqual({ count: 0 });
      db.close();
    }
  });

  it("rolls back a suppressed metadata update without losing the prior row", () => {
    const db = openDatabase();
    const target = locator("task-update-ignore");
    const before = patchProviderTaskMeta(db, target, { favorite: true }, 900, 16);
    db.exec(`CREATE TRIGGER local_meta_update_trigger
      BEFORE UPDATE ON provider_task_meta
      BEGIN SELECT RAISE(IGNORE); END`);

    expectLocalFailure(
      () => patchProviderTaskMeta(db, target, { pinned: true }, 901, 16),
      "CORRUPT_ROW",
    );
    expect(readProviderTaskMeta(db, target, 16)).toEqual(before);
    db.close();
  });
});

describe("provider index fork links", () => {
  const DIGEST = "a".repeat(64);

  it("links orphan and cross-provider locators idempotently and lists both directions", () => {
    const db = openDatabase();
    const source = scopedLocator("openai", "orphan/source");
    const target = scopedLocator("anthropic", "orphan/target", "2".repeat(64));

    const first = linkProviderFork(db, source, target, DIGEST, 10);
    const replay = linkProviderFork(db, source, target, DIGEST, 10);

    expect(replay).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.source)).toBe(true);
    expect(Object.isFrozen(first.target)).toBe(true);
    expect(listProviderForkLinks(db, source)).toEqual([first]);
    expect(listProviderForkLinks(db, target)).toEqual([first]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM provider_homes").get())
      .toEqual({ count: 0 });
    db.close();
  });

  it("rejects self-links and malformed digest/timestamp before writes", () => {
    const db = openDatabase();
    const source = locator("fork-invalid");
    for (const operation of [
      () => linkProviderFork(db, source, source, DIGEST, 1),
      () => linkProviderFork(db, source, locator("other"), "A".repeat(64), 1),
      () => linkProviderFork(db, source, locator("other"), "short", 1),
      () => linkProviderFork(db, source, locator("other"), DIGEST, -1),
      () => linkProviderFork(db, source, locator("other"), DIGEST, 1.5),
    ]) {
      expectLocalFailure(operation, "INVALID_INPUT");
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM provider_fork_links").get())
      .toEqual({ count: 0 });
    db.close();
  });

  it("refuses endpoint conflicts without overwriting the original link", () => {
    const db = openDatabase();
    const source = locator("fork-source");
    const target = locator("fork-target");
    const original = linkProviderFork(db, source, target, DIGEST, 20);

    expectLocalFailure(
      () => linkProviderFork(db, source, target, "b".repeat(64), 20),
      "FORK_CONFLICT",
    );
    expectLocalFailure(
      () => linkProviderFork(db, source, target, DIGEST, 21),
      "FORK_CONFLICT",
    );
    expect(listProviderForkLinks(db, source)).toEqual([original]);
    db.close();
  });

  it("orders incoming and outgoing links by time then serialized endpoints", () => {
    const db = openDatabase();
    const center = locator("fork-center");
    const links = [
      linkProviderFork(db, center, locator("fork-z"), DIGEST, 30),
      linkProviderFork(db, locator("fork-b"), center, "b".repeat(64), 20),
      linkProviderFork(db, center, locator("fork-a"), "c".repeat(64), 20),
      linkProviderFork(db, locator("fork-a"), center, "d".repeat(64), 20),
    ];
    const compareAscii = (left: string, right: string): number => (
      left === right ? 0 : left < right ? -1 : 1
    );
    const expected = [...links].sort((left, right) => (
      left.createdAt - right.createdAt ||
      compareAscii(serializeTaskLocator(left.source), serializeTaskLocator(right.source)) ||
      compareAscii(serializeTaskLocator(left.target), serializeTaskLocator(right.target))
    ));

    expect(listProviderForkLinks(db, center)).toEqual(expected);
    db.close();
  });

  it("composes with caller transactions and rolls back impossible trigger outcomes", () => {
    const source = locator("fork-transaction-source");
    const target = locator("fork-transaction-target");
    const transactionDb = openDatabase();
    transactionDb.exec("BEGIN");
    linkProviderFork(transactionDb, source, target, DIGEST, 40);
    transactionDb.exec("ROLLBACK");
    expect(listProviderForkLinks(transactionDb, source)).toEqual([]);
    transactionDb.close();

    for (const action of ["ignore", "delete", "rewrite"] as const) {
      const db = openDatabase();
      const trigger = action === "ignore"
        ? `CREATE TRIGGER fork_trigger BEFORE INSERT ON provider_fork_links
           BEGIN SELECT RAISE(IGNORE); END`
        : action === "delete"
          ? `CREATE TRIGGER fork_trigger AFTER INSERT ON provider_fork_links
             BEGIN DELETE FROM provider_fork_links
               WHERE source_provider = NEW.source_provider
                 AND source_home_fingerprint = NEW.source_home_fingerprint
                 AND source_native_task_id = NEW.source_native_task_id
                 AND target_provider = NEW.target_provider
                 AND target_home_fingerprint = NEW.target_home_fingerprint
                 AND target_native_task_id = NEW.target_native_task_id; END`
          : `CREATE TRIGGER fork_trigger AFTER INSERT ON provider_fork_links
             BEGIN UPDATE provider_fork_links SET transfer_digest = '${"e".repeat(64)}'
               WHERE source_provider = NEW.source_provider
                 AND source_home_fingerprint = NEW.source_home_fingerprint
                 AND source_native_task_id = NEW.source_native_task_id
                 AND target_provider = NEW.target_provider
                 AND target_home_fingerprint = NEW.target_home_fingerprint
                 AND target_native_task_id = NEW.target_native_task_id; END`;
      db.exec(trigger);

      expectLocalFailure(
        () => linkProviderFork(db, source, target, DIGEST, 40),
        "CORRUPT_ROW",
      );
      expect(listProviderForkLinks(db, source)).toEqual([]);
      db.close();
    }
  });

  it("bounds durable fork degree while preserving exact replay at capacity", () => {
    expect(PROVIDER_FORK_LINKS_PER_LOCATOR_LIMIT).toBe(1_024);
    const db = openDatabase();
    const center = locator("fork-capacity-center");
    const insert = db.prepare(`INSERT INTO provider_fork_links (
      source_provider, source_home_fingerprint, source_native_task_id,
      target_provider, target_home_fingerprint, target_native_task_id,
      created_at, transfer_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let index = 0; index < PROVIDER_FORK_LINKS_PER_LOCATOR_LIMIT; index += 1) {
      const target = locator(`fork-capacity-target-${index}`);
      insert.run(
        center.provider,
        center.homeFingerprint,
        center.nativeTaskId,
        target.provider,
        target.homeFingerprint,
        target.nativeTaskId,
        index,
        DIGEST,
      );
    }

    expect(linkProviderFork(
      db,
      center,
      locator("fork-capacity-target-0"),
      DIGEST,
      0,
    )).toMatchObject({ createdAt: 0, transferDigest: DIGEST });
    expectLocalFailure(
      () => linkProviderFork(db, center, locator("fork-capacity-overflow"), DIGEST, 2_000),
      "CAPACITY",
    );
    expect(listProviderForkLinks(db, center)).toHaveLength(
      PROVIDER_FORK_LINKS_PER_LOCATOR_LIMIT,
    );

    const extra = locator("fork-capacity-corrupt-extra");
    insert.run(
      center.provider,
      center.homeFingerprint,
      center.nativeTaskId,
      extra.provider,
      extra.homeFingerprint,
      extra.nativeTaskId,
      2_001,
      DIGEST,
    );
    expectLocalFailure(() => listProviderForkLinks(db, center), "CAPACITY");
    db.close();
  });
});

describe("provider index legacy provenance", () => {
  it("persists the first exact classification immutably and coexists with a verified map", () => {
    const db = openDatabase();
    classifyLegacySession(db, "legacy-session", "archive-v1-import", 10);
    classifyLegacySession(db, "legacy-session", "archive-v1-import", 10);

    expect(db.prepare("SELECT * FROM legacy_session_provenance").all()).toEqual([{
      legacy_session_id: "legacy-session",
      provenance: "archive-v1-import",
      observed_at: 10,
    }]);
    expectLocalFailure(
      () => classifyLegacySession(db, "legacy-session", "archive-v1-import", 11),
      "LEGACY_MAPPING_CONFLICT",
    );
    expectLocalFailure(
      () => classifyLegacySession(db, "legacy-session", "ambiguous", 10),
      "LEGACY_MAPPING_CONFLICT",
    );

    const target = locator("mapped-with-history");
    const authority = registerAuthority(db, target);
    mapVerifiedLegacySession(
      db,
      "legacy-session",
      target,
      { mappingSource: "live-provider-observation", verifiedAt: 20 },
      authority,
      () => authority,
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_session_provenance").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_session_task_map").get())
      .toEqual({ count: 1 });
    db.close();
  });

  it("rejects invalid provenance inputs and rolls back impossible trigger outcomes", () => {
    const invalidDb = openDatabase();
    for (const operation of [
      () => classifyLegacySession(invalidDb, "", "imported", 1),
      () => classifyLegacySession(invalidDb, "legacy", "guessed" as never, 1),
      () => classifyLegacySession(invalidDb, "legacy", "imported", -1),
    ]) {
      expectLocalFailure(operation, "INVALID_INPUT");
    }
    invalidDb.close();

    for (const action of ["ignore", "delete", "rewrite"] as const) {
      const db = openDatabase();
      const trigger = action === "ignore"
        ? `CREATE TRIGGER provenance_trigger BEFORE INSERT ON legacy_session_provenance
           BEGIN SELECT RAISE(IGNORE); END`
        : action === "delete"
          ? `CREATE TRIGGER provenance_trigger AFTER INSERT ON legacy_session_provenance
             BEGIN DELETE FROM legacy_session_provenance
               WHERE legacy_session_id = NEW.legacy_session_id; END`
          : `CREATE TRIGGER provenance_trigger AFTER INSERT ON legacy_session_provenance
             BEGIN UPDATE legacy_session_provenance SET observed_at = observed_at + 1
               WHERE legacy_session_id = NEW.legacy_session_id; END`;
      db.exec(trigger);
      expectLocalFailure(
        () => classifyLegacySession(db, `legacy-${action}`, "missing", 30),
        "CORRUPT_ROW",
      );
      expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_session_provenance").get())
        .toEqual({ count: 0 });
      db.close();
    }
  });
});

describe("provider index verified legacy mappings", () => {
  const EVIDENCE = Object.freeze({
    mappingSource: "live-provider-observation" as const,
    verifiedAt: 100,
  });

  it("requires exact evidence and registered authority before any recheck or write", () => {
    const db = openDatabase();
    const target = locator("verified-evidence");
    let recheckCalls = 0;
    const recheck = (): null => {
      recheckCalls += 1;
      return null;
    };

    for (const evidence of [
      {},
      { mappingSource: "guessed", verifiedAt: 1 },
      { mappingSource: "live-provider-observation", verifiedAt: -1 },
      { mappingSource: "live-provider-observation", verifiedAt: 1, extra: true },
      Object.defineProperty({ verifiedAt: 1 }, "mappingSource", {
        enumerable: true,
        get: () => "live-provider-observation",
      }),
      new Proxy(EVIDENCE, {}),
    ]) {
      expectLocalFailure(
        () => mapVerifiedLegacySession(
          db,
          "legacy-evidence",
          target,
          evidence as never,
          {
            provider: target.provider,
            homeFingerprint: target.homeFingerprint,
            canonicalHome: "/tmp/missing",
            registeredAt: 1,
          },
          recheck,
        ),
        "INVALID_INPUT",
      );
    }
    expect(recheckCalls).toBe(0);
    let authorityGetterCalls = 0;
    const accessorAuthority = Object.defineProperty({
      provider: target.provider,
      homeFingerprint: target.homeFingerprint,
      registeredAt: 1,
    }, "canonicalHome", {
      enumerable: true,
      get: () => {
        authorityGetterCalls += 1;
        return "/tmp/missing";
      },
    });
    for (const authority of [accessorAuthority, new Proxy({
      provider: target.provider,
      homeFingerprint: target.homeFingerprint,
      canonicalHome: "/tmp/missing",
      registeredAt: 1,
    }, {})]) {
      expectLocalFailure(
        () => mapVerifiedLegacySession(
          db,
          "legacy-evidence",
          target,
          EVIDENCE,
          authority as never,
          recheck,
        ),
        "INVALID_INPUT",
      );
    }
    expect(authorityGetterCalls).toBe(0);
    expect(recheckCalls).toBe(0);
    expectLocalFailure(
      () => mapVerifiedLegacySession(
        db,
        "legacy-evidence",
        target,
        EVIDENCE,
        {
          provider: target.provider,
          homeFingerprint: target.homeFingerprint,
          canonicalHome: "/tmp/missing",
          registeredAt: 1,
        },
        recheck,
      ),
      "UNKNOWN_HOME",
    );
    expect(recheckCalls).toBe(0);
    db.close();
  });

  it("maps an exact one-to-one observation and keeps the original attestation on replay", () => {
    const db = openDatabase();
    const target = locator("verified-idempotent");
    const authority = registerAuthority(db, target, "/tmp/verified-idempotent", 50);
    let recheckCalls = 0;
    const recheck = (): ProviderRegisteredHomeAuthority => {
      recheckCalls += 1;
      return authority;
    };

    mapVerifiedLegacySession(db, "legacy-map", target, EVIDENCE, authority, recheck);
    mapVerifiedLegacySession(
      db,
      "legacy-map",
      target,
      { ...EVIDENCE, verifiedAt: 200 },
      authority,
      recheck,
    );

    expect(recheckCalls).toBe(2);
    expect(db.prepare("SELECT * FROM legacy_session_task_map").all()).toEqual([{
      legacy_session_id: "legacy-map",
      provider: target.provider,
      home_fingerprint: target.homeFingerprint,
      native_task_id: target.nativeTaskId,
      mapping_source: "live-provider-observation",
      verified_at: 100,
    }]);
    db.close();
  });

  it("keeps provenance and mapping writes inside the caller transaction", () => {
    const db = openDatabase();
    const target = locator("caller-owned-mapping");
    const authority = registerAuthority(db, target, "/tmp/caller-owned-mapping");
    db.exec("BEGIN");
    classifyLegacySession(db, "caller-owned-history", "foreign-machine", 90);
    mapVerifiedLegacySession(
      db,
      "caller-owned-map",
      target,
      EVIDENCE,
      authority,
      () => authority,
    );
    db.exec("ROLLBACK");

    expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_session_provenance").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_session_task_map").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM provider_homes").get())
      .toEqual({ count: 1 });
    db.close();
  });

  it("accepts slash and Unicode native IDs under explicit registered authority", () => {
    const db = openDatabase();
    const target = locator("folder/任务-🪐");
    const authority = registerAuthority(db, target, "/tmp/unicode-native-id");
    mapVerifiedLegacySession(
      db,
      "legacy/unicode-会话",
      target,
      EVIDENCE,
      authority,
      () => authority,
    );
    expect(db.prepare(`SELECT legacy_session_id, native_task_id
      FROM legacy_session_task_map`).get()).toEqual({
      legacy_session_id: "legacy/unicode-会话",
      native_task_id: "folder/任务-🪐",
    });
    db.close();
  });

  it("refuses either-side remaps while preserving provider and home isolation", () => {
    const db = openDatabase();
    const first = locator("same-native-id");
    const firstAuthority = registerAuthority(db, first, "/tmp/map-first");
    const otherTask = locator("other-task");
    const otherTaskAuthority = firstAuthority;
    const isolated = scopedLocator("anthropic", "same-native-id", "2".repeat(64));
    const isolatedAuthority = registerAuthority(db, isolated, "/tmp/map-isolated");
    mapVerifiedLegacySession(db, "legacy-first", first, EVIDENCE, firstAuthority, () => firstAuthority);

    expectLocalFailure(
      () => mapVerifiedLegacySession(
        db,
        "legacy-first",
        otherTask,
        EVIDENCE,
        otherTaskAuthority,
        () => otherTaskAuthority,
      ),
      "LEGACY_MAPPING_CONFLICT",
    );
    expectLocalFailure(
      () => mapVerifiedLegacySession(
        db,
        "legacy-other",
        first,
        EVIDENCE,
        firstAuthority,
        () => firstAuthority,
      ),
      "LEGACY_MAPPING_CONFLICT",
    );
    mapVerifiedLegacySession(
      db,
      "legacy-isolated",
      isolated,
      EVIDENCE,
      isolatedAuthority,
      () => isolatedAuthority,
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_session_task_map").get())
      .toEqual({ count: 2 });
    db.close();
  });

  it("rechecks authority in the savepoint and rolls back recheck side effects on loss", () => {
    const db = openDatabase();
    const target = locator("authority-lost");
    const authority = registerAuthority(db, target, "/tmp/authority-lost");
    expectLocalFailure(
      () => mapVerifiedLegacySession(db, "legacy-lost", target, EVIDENCE, authority, () => {
        db.prepare(`DELETE FROM provider_homes
          WHERE provider = ? AND home_fingerprint = ?`)
          .run(target.provider, target.homeFingerprint);
        return null;
      }),
      "CORRUPT_ROW",
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM provider_homes").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_session_task_map").get())
      .toEqual({ count: 0 });
    expectLocalFailure(
      () => mapVerifiedLegacySession(
        db,
        "legacy-malformed-recheck",
        target,
        EVIDENCE,
        authority,
        () => ({ ...authority, registeredAt: "bad" }) as never,
      ),
      "CORRUPT_ROW",
    );
    db.close();
  });

  it("rolls back mappings suppressed, deleted, rewritten, or stripped of authority by triggers", () => {
    for (const action of [
      "ignore",
      "delete",
      "rewrite",
      "authority-delete",
      "authority-rewrite",
    ] as const) {
      const db = openDatabase();
      const target = locator(`map-trigger-${action}`);
      const authority = registerAuthority(db, target, `/tmp/map-trigger-${action}`);
      const trigger = action === "ignore"
        ? `CREATE TRIGGER mapping_trigger BEFORE INSERT ON legacy_session_task_map
           BEGIN SELECT RAISE(IGNORE); END`
        : action === "delete"
          ? `CREATE TRIGGER mapping_trigger AFTER INSERT ON legacy_session_task_map
             BEGIN DELETE FROM legacy_session_task_map
               WHERE legacy_session_id = NEW.legacy_session_id; END`
          : action === "rewrite"
            ? `CREATE TRIGGER mapping_trigger AFTER INSERT ON legacy_session_task_map
               BEGIN UPDATE legacy_session_task_map SET verified_at = verified_at + 1
                 WHERE legacy_session_id = NEW.legacy_session_id; END`
            : action === "authority-delete"
              ? `CREATE TRIGGER mapping_trigger AFTER INSERT ON legacy_session_task_map
                 BEGIN DELETE FROM provider_homes
                   WHERE provider = NEW.provider
                     AND home_fingerprint = NEW.home_fingerprint; END`
              : `CREATE TRIGGER mapping_trigger AFTER INSERT ON legacy_session_task_map
                 BEGIN UPDATE provider_homes SET canonical_home = '/tmp/rewritten-authority'
                   WHERE provider = NEW.provider
                     AND home_fingerprint = NEW.home_fingerprint; END`;
      db.exec(trigger);
      expectLocalFailure(
        () => mapVerifiedLegacySession(
          db,
          `legacy-trigger-${action}`,
          target,
          EVIDENCE,
          authority,
          () => authority,
        ),
        "CORRUPT_ROW",
      );
      expect(db.prepare("SELECT COUNT(*) AS count FROM legacy_session_task_map").get())
        .toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM provider_homes").get())
        .toEqual({ count: 1 });
      db.close();
    }
  });
});

describe("provider index local-state failure provenance", () => {
  it("maps unavailable tables to database failures rather than persisted corruption", () => {
    const metadataDb = openDatabase();
    metadataDb.exec("DROP TABLE provider_task_meta");
    expectLocalFailure(
      () => patchProviderTaskMeta(metadataDb, locator("missing-meta-table"), {
        favorite: true,
      }, 1, 16),
      "DATABASE_UNAVAILABLE",
    );
    metadataDb.close();

    const forkDb = openDatabase();
    forkDb.exec("DROP TABLE provider_fork_links");
    expectLocalFailure(
      () => linkProviderFork(
        forkDb,
        locator("missing-fork-source"),
        locator("missing-fork-target"),
        "a".repeat(64),
        1,
      ),
      "DATABASE_UNAVAILABLE",
    );
    forkDb.close();

    const provenanceDb = openDatabase();
    provenanceDb.exec("DROP TABLE legacy_session_provenance");
    expectLocalFailure(
      () => classifyLegacySession(provenanceDb, "missing-provenance-table", "missing", 1),
      "DATABASE_UNAVAILABLE",
    );
    provenanceDb.close();

    const mappingDb = openDatabase();
    const target = locator("missing-authority-table");
    const authority = registerAuthority(mappingDb, target, "/tmp/missing-authority-table");
    mappingDb.exec("DROP TABLE provider_homes");
    expectLocalFailure(
      () => mapVerifiedLegacySession(
        mappingDb,
        "missing-authority-table",
        target,
        { mappingSource: "live-provider-observation", verifiedAt: 1 },
        authority,
        () => authority,
      ),
      "DATABASE_UNAVAILABLE",
    );
    mappingDb.close();
  });
});
