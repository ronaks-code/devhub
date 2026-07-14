import {
  PROVIDER_INDEX_STORE_DEFAULTS,
  PROVIDER_INDEX_STORE_HARD_LIMITS,
  ProviderIndexStoreError,
} from "../../src/providers/index.js";
import type {
  IndexedProviderTask,
  IndexedProviderTaskSummary,
  IndexedProviderTurn,
  ProviderHomeScope,
  ProviderIndexCompletion,
  ProviderIndexPromotion,
  ProviderIndexStage,
  ProviderIndexStoreErrorCode,
  ProviderIndexStoreOptions,
} from "../../src/providers/index.js";

void PROVIDER_INDEX_STORE_DEFAULTS;
void PROVIDER_INDEX_STORE_HARD_LIMITS;
void ProviderIndexStoreError;
type PublicProviderIndexTypes =
  | IndexedProviderTask
  | IndexedProviderTaskSummary
  | IndexedProviderTurn
  | ProviderHomeScope
  | ProviderIndexCompletion
  | ProviderIndexPromotion
  | ProviderIndexStage
  | ProviderIndexStoreErrorCode
  | ProviderIndexStoreOptions;
declare const publicProviderIndexType: PublicProviderIndexTypes;
void publicProviderIndexType;

// @ts-expect-error backend raw-home carrier must not cross the providers package boundary
import type { ProviderIndexRegisteredHome } from "../../src/providers/index.js";
// @ts-expect-error backend normalized callback/config state is not public provider API
import type { NormalizedProviderIndexStoreConfig } from "../../src/providers/index.js";
// @ts-expect-error backend SQL row shape is not public provider API
import type { ProviderEventCacheRow } from "../../src/providers/index.js";
// @ts-expect-error backend prepared persistence shape is not public provider API
import type { PreparedProviderTaskSnapshot } from "../../src/providers/index.js";
// @ts-expect-error backend config preparation is not public provider API
import { normalizeProviderIndexStoreOptions } from "../../src/providers/index.js";
// @ts-expect-error backend clock callback execution is not public provider API
import { readProviderIndexNow } from "../../src/providers/index.js";
// @ts-expect-error backend token callback execution is not public provider API
import { createProviderIndexOwnerToken } from "../../src/providers/index.js";
// @ts-expect-error backend summary preparation is not public provider API
import { prepareProviderTaskSummary } from "../../src/providers/index.js";
// @ts-expect-error backend snapshot preparation is not public provider API
import { prepareProviderTaskSnapshot } from "../../src/providers/index.js";
// @ts-expect-error backend snapshot fingerprinting is not public provider API
import { providerTaskSnapshotFingerprint } from "../../src/providers/index.js";
// @ts-expect-error backend receipt derivation is not public provider API
import { providerTaskSnapshotReceiptKey } from "../../src/providers/index.js";
// @ts-expect-error backend cache-row decoding is not public provider API
import { decodeCachedProviderEvent } from "../../src/providers/index.js";

type BackendOnly =
  | ProviderIndexRegisteredHome
  | NormalizedProviderIndexStoreConfig
  | ProviderEventCacheRow
  | PreparedProviderTaskSnapshot;
declare const backendOnly: BackendOnly;
void backendOnly;
void normalizeProviderIndexStoreOptions;
void readProviderIndexNow;
void createProviderIndexOwnerToken;
void prepareProviderTaskSummary;
void prepareProviderTaskSnapshot;
void providerTaskSnapshotFingerprint;
void providerTaskSnapshotReceiptKey;
void decodeCachedProviderEvent;
