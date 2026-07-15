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
  ProviderHomeRegistration,
  ProviderIndexCompletion,
  ProviderIndexPage,
  ProviderIndexPromotion,
  ProviderIndexScope,
  ProviderIndexStage,
  ProviderIndexStoreErrorCode,
  ProviderIndexStoreOptions,
  ProviderCacheClearResult,
  ProviderForkLink,
  ProviderMetadataJson,
  ProviderMetadataObject,
  ProviderReconciliationReason,
  ProviderReconciliationState,
  ProviderReconciliationStore,
  ProviderTaskMeta,
  ProviderTaskMetaPatch,
  LegacySessionProvenance,
  ReconciliationLatchInput,
  VerifiedLegacyMapping,
  VerifiedLegacySessionResolution,
} from "../../src/providers/index.js";
import { ProviderTaskIndexStore as RootProviderTaskIndexStore } from "../../src/index.js";

void PROVIDER_INDEX_STORE_DEFAULTS;
void PROVIDER_INDEX_STORE_HARD_LIMITS;
void ProviderIndexStoreError;
type PublicProviderIndexTypes =
  | IndexedProviderTask
  | IndexedProviderTaskSummary
  | IndexedProviderTurn
  | ProviderHomeScope
  | ProviderHomeRegistration
  | ProviderIndexCompletion
  | ProviderIndexPage<IndexedProviderTaskSummary>
  | ProviderIndexPromotion
  | ProviderIndexScope
  | ProviderIndexStage
  | ProviderIndexStoreErrorCode
  | ProviderIndexStoreOptions
  | ProviderCacheClearResult
  | ProviderForkLink
  | ProviderMetadataJson
  | ProviderMetadataObject
  | ProviderReconciliationReason
  | ProviderReconciliationState
  | ProviderReconciliationStore
  | ProviderTaskMeta
  | ProviderTaskMetaPatch
  | LegacySessionProvenance
  | ReconciliationLatchInput
  | VerifiedLegacyMapping
  | VerifiedLegacySessionResolution;
declare const publicProviderIndexType: PublicProviderIndexTypes;
void publicProviderIndexType;
void RootProviderTaskIndexStore;

declare const rootProviderIndexStore: InstanceType<typeof RootProviderTaskIndexStore>;
// @ts-expect-error TranscriptIndex exclusively owns the shared database connection
rootProviderIndexStore.close();

// @ts-expect-error backend raw-home carrier must not cross the providers package boundary
import type { ProviderIndexRegisteredHome } from "../../src/providers/index.js";
// @ts-expect-error concrete backend store must not cross the providers package boundary
import { ProviderTaskIndexStore } from "../../src/providers/index.js";
// @ts-expect-error backend observation capability must not cross the providers package boundary
import type { ProviderTaskObservationToken } from "../../src/providers/index.js";
// @ts-expect-error backend normalized callback/config state is not public provider API
import type { NormalizedProviderIndexStoreConfig } from "../../src/providers/index.js";
// @ts-expect-error backend SQL row shape is not public provider API
import type { ProviderEventCacheRow } from "../../src/providers/index.js";
// @ts-expect-error backend prepared persistence shape is not public provider API
import type { PreparedProviderTaskSnapshot } from "../../src/providers/index.js";
// @ts-expect-error backend prepared summary shape is not public provider API
import type { PreparedProviderTaskSummary } from "../../src/providers/index.js";
// @ts-expect-error backend prepared turn shape is not public provider API
import type { PreparedProviderTurn } from "../../src/providers/index.js";
// @ts-expect-error backend prepared event shape is not public provider API
import type { PreparedProviderEvent } from "../../src/providers/index.js";
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
// @ts-expect-error internal one-pass cache projection is not public provider API
import { projectProviderEventCacheBundleFromSnapshot } from "../../src/providers/index.js";
// @ts-expect-error internal readable content transform is not public provider API
import { readableContentString } from "../../src/providers/index.js";
// @ts-expect-error internal injective content transform is not public provider API
import { injectiveContentString } from "../../src/providers/index.js";
// @ts-expect-error trusted snapshot hashing is module-private even on the backend module
import { providerTaskSnapshotFingerprint as privateSnapshotFingerprint } from "../../src/provider-index/store-codec.js";
// @ts-expect-error trusted receipt derivation is module-private even on the backend module
import { providerTaskSnapshotReceiptKey as privateSnapshotReceiptKey } from "../../src/provider-index/store-codec.js";

type BackendOnly =
  | ProviderIndexRegisteredHome
  | ProviderTaskObservationToken
  | NormalizedProviderIndexStoreConfig
  | ProviderEventCacheRow
  | PreparedProviderTaskSnapshot
  | PreparedProviderTaskSummary
  | PreparedProviderTurn
  | PreparedProviderEvent;
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
void projectProviderEventCacheBundleFromSnapshot;
void readableContentString;
void injectiveContentString;
void privateSnapshotFingerprint;
void privateSnapshotReceiptKey;
void ProviderTaskIndexStore;

declare const reconciliationStore: ProviderReconciliationStore;
// @ts-expect-error canonical home resolution is backend-only
reconciliationStore.resolveHome("openai", "a".repeat(64));
