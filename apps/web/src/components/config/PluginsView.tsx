import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Blocks, CircleSlash, Store } from "lucide-react";
import { api, NotImplementedError } from "../../lib/api";
import type { ConfigScope, MarketplaceDef, PluginDef, PluginsResult } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui";

/** A scope chip used in the list rows (matches SkillsManager/AgentsLibrary styling). */
function ScopeChip({ scope }: { scope: ConfigScope }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1",
        scope === "global"
          ? "bg-clay-500/10 text-clay-300 ring-clay-500/25"
          : "bg-sky-500/10 text-sky-300 ring-sky-500/25",
      )}
    >
      {scope}
    </span>
  );
}

/** Enabled/disabled state chip — green when on, muted when off. */
function EnabledChip({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300 ring-1 ring-emerald-500/25">
      enabled
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 ring-1 ring-zinc-700">
      <CircleSlash className="h-2.5 w-2.5" />
      disabled
    </span>
  );
}

function PluginRow({ plugin }: { plugin: PluginDef }) {
  return (
    <li
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border bg-zinc-900/30 px-3.5 py-3",
        plugin.enabled ? "border-zinc-800/80" : "border-zinc-800/50 opacity-75",
      )}
    >
      <div className="flex items-center gap-2">
        <Blocks className="h-4 w-4 shrink-0 text-clay-400" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-100">
          {plugin.name}
        </span>
        {plugin.version ? (
          <span
            className="rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400"
            title="Version (from manifest)"
          >
            v{plugin.version}
          </span>
        ) : null}
        <EnabledChip enabled={plugin.enabled} />
        <ScopeChip scope={plugin.scope} />
      </div>
      {plugin.description ? (
        <p className="text-[12px] leading-relaxed text-zinc-400">{plugin.description}</p>
      ) : null}
      {plugin.marketplace ? (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-600">
          <Store className="h-3 w-3" />
          <span className="truncate" title={`Installed from ${plugin.marketplace}`}>
            {plugin.marketplace}
          </span>
        </div>
      ) : null}
    </li>
  );
}

function MarketplaceRow({ mp }: { mp: MarketplaceDef }) {
  return (
    <li className="flex items-center gap-2 rounded-lg border border-zinc-800/60 bg-zinc-900/20 px-3 py-2">
      <Store className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-zinc-200">
        {mp.name}
      </span>
      {mp.url ? (
        <span className="min-w-0 truncate font-mono text-[10.5px] text-zinc-600" title={mp.url} dir="rtl">
          {mp.url}
        </span>
      ) : null}
      {mp.enabled === false ? (
        <span className="shrink-0 rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
          disabled
        </span>
      ) : null}
    </li>
  );
}

/**
 * Read-only view of the installed Claude Code plugins + configured marketplaces,
 * fetched from GET /api/config/plugins (which reads ~/.claude/plugins/). Shows
 * each plugin's name, version, marketplace, enabled state, and scope, plus the
 * list of known marketplaces. No writes — plugins are installed via the CLI; this
 * surfaces what's present.
 *
 * Degrades gracefully when the server hasn't shipped the route yet: a
 * NotImplementedError renders a quiet "not available on this server yet" panel
 * (mirroring how WorktreePanel handles its pending routes).
 */
export function PluginsView() {
  const [data, setData] = useState<PluginsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setUnavailable(false);
    api
      .config.plugins()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof NotImplementedError) setUnavailable(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Enabled first, then global before project, then alphabetical — a stable,
  // sensible reading order.
  const plugins = useMemo(() => {
    if (!data) return [];
    const rankScope = (s: ConfigScope) => (s === "global" ? 0 : 1);
    return [...data.plugins].sort(
      (a, b) =>
        Number(b.enabled) - Number(a.enabled) ||
        rankScope(a.scope) - rankScope(b.scope) ||
        a.name.localeCompare(b.name),
    );
  }, [data]);

  const marketplaces = useMemo(() => {
    if (!data) return [];
    return [...data.marketplaces].sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  if (unavailable) {
    return (
      <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-4 py-10 text-center">
        <Blocks className="mx-auto mb-2 h-8 w-8 text-zinc-700" />
        <div className="text-[13px] font-medium text-zinc-400">Plugins not available here</div>
        <p className="mx-auto mt-1 max-w-sm text-[11.5px] text-zinc-600">
          This server doesn't expose <code className="text-zinc-500">/api/config/plugins</code> yet.
          Installed plugins live under <code className="text-zinc-500">~/.claude/plugins/</code>.
        </p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-[13px] text-red-300">
        <AlertCircle className="h-4 w-4 shrink-0" />
        Failed to load plugins: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }
  if (plugins.length === 0 && marketplaces.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-4 py-10 text-center">
        <Blocks className="mx-auto mb-2 h-8 w-8 text-zinc-700" />
        <div className="text-[13px] font-medium text-zinc-400">No plugins installed</div>
        <p className="mx-auto mt-1 max-w-sm text-[11.5px] text-zinc-600">
          Install plugins with the Claude Code CLI and they'll appear here, read from{" "}
          <code className="text-zinc-500">~/.claude/plugins/</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <Blocks className="h-4 w-4 text-zinc-500" />
          <h2 className="text-[13px] font-semibold text-zinc-200">Installed plugins</h2>
          <span className="rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
            {plugins.length}
          </span>
        </div>
        {plugins.length === 0 ? (
          <p className="text-[12px] italic text-zinc-600">No plugins installed.</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {plugins.map((p) => (
              <PluginRow key={`${p.scope}:${p.name}`} plugin={p} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <Store className="h-4 w-4 text-zinc-500" />
          <h2 className="text-[13px] font-semibold text-zinc-200">Marketplaces</h2>
          <span className="rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
            {marketplaces.length}
          </span>
        </div>
        {marketplaces.length === 0 ? (
          <p className="text-[12px] italic text-zinc-600">No marketplaces configured.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {marketplaces.map((m) => (
              <MarketplaceRow key={m.name} mp={m} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
