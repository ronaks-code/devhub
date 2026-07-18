/**
 * Flag-ON provider setup surface for the unified task index locator transport (M5).
 *
 * This is the ONLY place the web UI consumes the `unifiedTaskIndex` locator seam for
 * provider *setup*: it calls `selectProviderTransport(features)` and, when the flag is
 * applied true, discovers provider homes exclusively through the path-free
 * `provider-index-api` facade (`homes()` → `PublicProviderHome[]`). A `PublicProviderHome`
 * carries only `{ provider, homeFingerprint, status, capabilities }` — never a raw
 * filesystem home — so this view can never render or request one. When the flag is off
 * the transport resolves to `direct` and this component renders the fallback (the caller
 * keeps the preserved key-based `providerApi` setup as the rollback surface).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { DevHubFeatureFlags, ProviderId } from "@devhub/engine/providers";
import { AlertTriangle } from "lucide-react";
import {
  providerIndexApi,
  selectProviderTransport,
  type ProviderIndexApiClient,
  type PublicProviderHome,
} from "../lib/provider-index-api.js";
import { EmptyState, Spinner } from "./ui";
import { IndexedApprovalInbox } from "./CodexApprovalCard.js";

const PROVIDER_LABEL: Readonly<Record<ProviderId, string>> = Object.freeze({
  openai: "OpenAI · Codex",
  anthropic: "Anthropic · Claude",
});

const PROVIDER_PRODUCT: Readonly<Record<ProviderId, "Codex" | "Claude">> = Object.freeze({
  openai: "Codex",
  anthropic: "Claude",
});

/**
 * Homes eligible for the native setup: same provider, verified-available, and exposing at
 * least list+read. Sorted by the opaque fingerprint so the picker order is stable and
 * path-free (a raw home never participates in ordering).
 */
export function availableProviderHomes(
  homes: readonly PublicProviderHome[],
  provider: ProviderId,
): readonly PublicProviderHome[] {
  return homes
    .filter(
      (home) =>
        home.provider === provider &&
        home.status === "available" &&
        home.capabilities !== null &&
        home.capabilities.list &&
        home.capabilities.read,
    )
    .slice()
    .sort((a, b) => a.homeFingerprint.localeCompare(b.homeFingerprint));
}

/** A short, display-only slice of the opaque 64-hex fingerprint (never a path). */
export function shortHomeFingerprint(fingerprint: string): string {
  return fingerprint.length > 12 ? `${fingerprint.slice(0, 12)}…` : fingerprint;
}

const SUMMARY_CAPABILITIES = ["list", "read", "start", "resume", "send"] as const;

/** Human summary of the enabled capabilities for the selected home (path-free). */
export function providerHomeCapabilitySummary(home: PublicProviderHome): string {
  if (!home.capabilities) return "no verified capabilities";
  const caps = home.capabilities;
  const enabled = SUMMARY_CAPABILITIES.filter((key) => caps[key]);
  return enabled.length > 0 ? enabled.join(" · ") : "no verified capabilities";
}

export interface ProviderHomeDiscovery {
  readonly homes: readonly PublicProviderHome[];
  readonly selectedFingerprint: string | null;
}

/**
 * Discover provider homes through the path-free facade. Consumes only `homes()` — never a
 * raw-home key route — and preselects the preferred fingerprint when it is still available,
 * else the first eligible home. The result is fingerprint-addressed end to end.
 */
export async function discoverProviderHomes(
  client: Pick<ProviderIndexApiClient, "homes">,
  provider: ProviderId,
  preferredHomeFingerprint?: string,
): Promise<ProviderHomeDiscovery> {
  const result = await client.homes();
  const homes = availableProviderHomes(result, provider);
  const selectedFingerprint =
    preferredHomeFingerprint &&
    homes.some((home) => home.homeFingerprint === preferredHomeFingerprint)
      ? preferredHomeFingerprint
      : homes[0]?.homeFingerprint ?? null;
  return { homes, selectedFingerprint };
}

export interface ProviderHomePickerProps {
  readonly homes: readonly PublicProviderHome[];
  readonly selectedFingerprint: string | null;
  readonly onSelect: (fingerprint: string) => void;
  readonly label: string;
  readonly product: string;
}

/** Presentational, path-free home picker: fingerprints + capabilities only, never a path. */
export function ProviderHomePicker({
  homes,
  selectedFingerprint,
  onSelect,
  label,
  product,
}: ProviderHomePickerProps) {
  const selectedHome =
    homes.find((home) => home.homeFingerprint === selectedFingerprint) ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-950 text-zinc-200">
      <div className="border-b border-zinc-800/80 p-3">
        <div className="text-[11px] font-medium text-zinc-300">{label}</div>
        {homes.length > 1 ? (
          <label className="mt-1 block">
            <span className="sr-only">{product} home</span>
            <select
              aria-label={`${product} home`}
              value={selectedFingerprint ?? ""}
              onChange={(event) => onSelect(event.target.value)}
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-[10.5px] text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
            >
              {homes.map((home) => (
                <option key={home.homeFingerprint} value={home.homeFingerprint}>
                  {shortHomeFingerprint(home.homeFingerprint)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div
            className="mt-1 truncate font-mono text-[10.5px] text-zinc-600"
            title={selectedHome?.homeFingerprint}
          >
            {selectedHome ? shortHomeFingerprint(selectedHome.homeFingerprint) : ""}
          </div>
        )}
      </div>
      {selectedHome ? (
        <div className="p-3 text-[11px] text-zinc-500">
          <span className="text-zinc-400">Verified capabilities:</span>{" "}
          {providerHomeCapabilitySummary(selectedHome)}
        </div>
      ) : null}
    </div>
  );
}

export interface ProviderHomeSetupProps {
  /** Resolved DevHub feature flags; the transport is chosen from these, never defaulted on. */
  readonly features: Partial<DevHubFeatureFlags> | undefined;
  readonly provider?: ProviderId;
  /** Injectable for tests; defaults to the shared path-free facade singleton. */
  readonly indexedClient?: ProviderIndexApiClient;
  /** Preferred fingerprint to preselect (opaque; never a raw home). */
  readonly preferredHomeFingerprint?: string;
  readonly onSelectHome?: (home: PublicProviderHome) => void;
  /** Rendered when the transport resolves to `direct` (flag-off rollback surface). */
  readonly fallback?: ReactNode;
}

/** PublicProviderHome-only provider setup; discovers/renders only when the flag is applied true. */
export function ProviderHomeSetup({
  features,
  provider = "openai",
  indexedClient,
  preferredHomeFingerprint,
  onSelectHome,
  fallback,
}: ProviderHomeSetupProps) {
  const label = PROVIDER_LABEL[provider];
  const product = PROVIDER_PRODUCT[provider];

  // Consume the seam: the flag alone decides the transport (never defaulted on here).
  const transport = selectProviderTransport(features, indexedClient ?? providerIndexApi);
  const indexed = transport.mode === "indexed" ? transport.client : null;

  const [homes, setHomes] = useState<readonly PublicProviderHome[] | null>(null);
  const [selectedFingerprint, setSelectedFingerprint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discoveryNonce, setDiscoveryNonce] = useState(0);

  useEffect(() => {
    if (!indexed) return;
    let active = true;
    setHomes(null);
    setError(null);
    discoverProviderHomes(indexed, provider, preferredHomeFingerprint)
      .then((discovery) => {
        if (!active) return;
        setHomes(discovery.homes);
        setSelectedFingerprint(discovery.selectedFingerprint);
      })
      .catch(() => {
        if (!active) return;
        setError(`Native ${product} runtime could not be verified.`);
        setHomes([]);
        setSelectedFingerprint(null);
      });
    return () => {
      active = false;
    };
  }, [indexed, provider, preferredHomeFingerprint, product, discoveryNonce]);

  const selectedHome = useMemo(
    () => homes?.find((home) => home.homeFingerprint === selectedFingerprint) ?? null,
    [homes, selectedFingerprint],
  );

  useEffect(() => {
    if (selectedHome) onSelectHome?.(selectedHome);
  }, [selectedHome, onSelectHome]);

  // Flag-off: the direct key-based setup owns this surface; render the rollback fallback.
  if (transport.mode !== "indexed") return <>{fallback ?? null}</>;

  if (homes === null) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-busy="true"
        className="flex min-h-0 flex-1 items-center justify-center bg-zinc-950"
      >
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Spinner className="h-4 w-4" />
          Discovering native {product} homes…
        </div>
      </div>
    );
  }

  if (homes.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-zinc-950">
        <div
          role="status"
          className="border-b border-amber-900/40 bg-amber-500/5 px-4 py-3 text-amber-200"
        >
          <div className="flex items-center gap-2 text-xs font-medium">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> No native {label} home is
            available
          </div>
          <p className="mt-1 text-[11px] text-zinc-500">
            {error ??
              `No verified ${label} home was discovered. Native controls stay hidden until one is registered.`}
          </p>
        </div>
        {fallback ?? (
          <EmptyState
            icon={<AlertTriangle className="h-11 w-11" />}
            title="No native home connected"
            hint="Native setup stays hidden while no verified provider home is available."
          />
        )}
        <div className="border-t border-zinc-900 px-4 py-3 text-center">
          <button
            type="button"
            onClick={() => {
              setError(null);
              setHomes(null);
              setDiscoveryNonce((current) => current + 1);
            }}
            className="rounded-md px-2.5 py-1 text-xs text-zinc-400 ring-1 ring-zinc-800 hover:bg-zinc-900 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
          >
            Retry native runtime
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-950">
      <ProviderHomePicker
        homes={homes}
        selectedFingerprint={selectedFingerprint}
        onSelect={setSelectedFingerprint}
        label={label}
        product={product}
      />
      {selectedHome ? <IndexedApprovalInbox home={selectedHome} client={transport.client} /> : null}
    </div>
  );
}
