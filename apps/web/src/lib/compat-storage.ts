/**
 * DevHub ⇄ Claude-UI localStorage compatibility layer (M5 Task 7).
 *
 * The app is being renamed from "claude-ui" to "devhub". Every persisted browser
 * key moves from the `claude-ui:*` namespace to `devhub:*` (and the access token
 * from `claude-ui-token` to `devhub-token`). This module is the single seam every
 * migrated hook/component routes its localStorage through so the rename never
 * loses a returning user's saved state.
 *
 * Plain words: the address of each saved thing changed. When we look something up
 * we first check the NEW address; if it's empty we check the OLD address, and if we
 * find it there we quietly leave a copy at the new address for next time. We never
 * erase the old copy on a read, so an older build of the app (rolled back) still
 * finds its data exactly where it left it.
 *
 * Rules (the contract this module guarantees):
 *  - New writes target ONLY the DevHub key. The legacy key is never written on a
 *    normal write, so a rollback keeps reading its own last value.
 *  - Reads try the DevHub key first, then the exact legacy key. A successful legacy
 *    read is COPIED forward to the DevHub key WITHOUT deleting or rewriting the
 *    legacy value.
 *  - Removal is the one place we also clear the legacy key — otherwise the read
 *    fallback would "resurrect" a value the user explicitly cleared (a logout that
 *    left the old token behind, an emptied draft that reappeared). Removal is an
 *    intentional clear, distinct from the copy-on-read rule above.
 *  - Every storage access is SSR-guarded and wrapped in try/catch: a missing
 *    window (server render), disabled storage (sandboxed iframe), private-mode
 *    denial, or a quota-exceeded write is always non-fatal — callers keep working
 *    in memory.
 *
 * There is no NUL or raw filesystem path in any key this module produces; keys are
 * opaque namespaced strings chosen by the caller.
 */

const DEVHUB_PREFIX = "devhub:";
const LEGACY_PREFIX = "claude-ui:";
const DEVHUB_TOKEN_KEY = "devhub-token";
const LEGACY_TOKEN_KEY = "claude-ui-token";

/**
 * The access-token keys, exported so the API layer can name them directly. Reads
 * still go through {@link readCompat}/{@link writeCompat}/{@link removeCompat}.
 */
export const TOKEN_KEY = DEVHUB_TOKEN_KEY;
export const LEGACY_TOKEN = LEGACY_TOKEN_KEY;

/**
 * The localStorage handle, or null when storage is unavailable. Merely *accessing*
 * `window.localStorage` can throw (some sandboxed iframes, storage disabled by
 * policy), so the access itself is guarded — not just the get/set calls.
 */
function getStore(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Map a DevHub key to its exact legacy `claude-ui:*` / `claude-ui-token` twin, or
 * null when the key has no legacy predecessor (a brand-new DevHub-only key, or a
 * key that isn't in the DevHub namespace at all — we never guess a mapping).
 */
export function legacyKeyFor(devhubKey: string): string | null {
  if (devhubKey === DEVHUB_TOKEN_KEY) return LEGACY_TOKEN_KEY;
  if (devhubKey.startsWith(DEVHUB_PREFIX)) {
    return LEGACY_PREFIX + devhubKey.slice(DEVHUB_PREFIX.length);
  }
  return null;
}

/**
 * Read a value: DevHub key first, then the exact legacy key. On a legacy hit the
 * value is copied forward to the DevHub key (best-effort, never touching the legacy
 * value) and returned. Returns null when neither key holds a value or storage is
 * unavailable. Never throws.
 */
export function readCompat(devhubKey: string): string | null {
  const store = getStore();
  if (!store) return null;

  try {
    const current = store.getItem(devhubKey);
    if (current !== null) return current;
  } catch {
    // A throwing getItem (private mode / disabled) is non-fatal: fall through to
    // the legacy attempt, which is separately guarded.
  }

  const legacyKey = legacyKeyFor(devhubKey);
  if (legacyKey === null) return null;

  let legacyValue: string | null = null;
  try {
    legacyValue = store.getItem(legacyKey);
  } catch {
    return null;
  }
  if (legacyValue === null) return null;

  // Copy legacy → DevHub so the next read hits the new key directly. We do NOT
  // delete or rewrite the legacy value: a rolled-back client must still find it.
  try {
    store.setItem(devhubKey, legacyValue);
  } catch {
    // Quota / denied — non-fatal. We still return the value we found.
  }
  return legacyValue;
}

/**
 * Write a value to the DevHub key ONLY. The legacy key is intentionally left
 * untouched so a rollback keeps its last-known value. Non-fatal on any storage
 * error.
 */
export function writeCompat(devhubKey: string, value: string): void {
  const store = getStore();
  if (!store) return;
  try {
    store.setItem(devhubKey, value);
  } catch {
    /* quota / disabled — non-fatal */
  }
}

/**
 * Remove a value. Clears BOTH the DevHub key and its legacy twin so a value the
 * user explicitly cleared cannot be resurrected by {@link readCompat}'s legacy
 * fallback (logout, emptied draft). Non-fatal on any storage error.
 */
export function removeCompat(devhubKey: string): void {
  const store = getStore();
  if (!store) return;
  try {
    store.removeItem(devhubKey);
  } catch {
    /* non-fatal */
  }
  const legacyKey = legacyKeyFor(devhubKey);
  if (legacyKey === null) return;
  try {
    store.removeItem(legacyKey);
  } catch {
    /* non-fatal */
  }
}
