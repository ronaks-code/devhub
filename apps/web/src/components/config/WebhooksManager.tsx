import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  Loader2,
  Pencil,
  Plus,
  Send,
  Trash2,
  Webhook as WebhookIcon,
  X,
  XCircle,
} from "lucide-react";
import {
  api,
  NotImplementedError,
  WEBHOOK_EVENT_KINDS,
  type Webhook,
  type WebhookEventKind,
  type WebhookInput,
  type WebhookTestResult,
} from "../../lib/api";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui";

const inputCls =
  "rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[13px] text-zinc-200 ring-1 ring-zinc-800 placeholder:text-zinc-600 focus:outline-none focus:ring-clay-500/40";

/** Human-friendly labels for the event kinds shown in the multi-select. */
const EVENT_LABELS: Record<WebhookEventKind, string> = {
  "session.finished": "Session finished",
  "session.stalled": "Session stalled",
  "budget.warn": "Budget warning",
  "budget.over": "Budget over",
  "turn.error": "Turn error",
};

/**
 * Validate a webhook URL client-side: must parse and use the http or https scheme
 * (the server enforces the same, plus refuses file:/// and other schemes — this is
 * just an early, friendlier check before we POST). Returns null when valid, else a
 * human-readable reason.
 */
function urlProblem(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return "A URL is required.";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "That doesn't look like a valid URL.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "URL must start with http:// or https://.";
  }
  return null;
}

/**
 * The add/edit form. Drives a webhook through plain fields — a URL, a checkbox grid
 * of event kinds, an optional label, and an enabled toggle — mirroring McpManager's
 * inline-editor shape (busy/onCancel/onSubmit). Validates the URL is http(s) before
 * handing a {@link WebhookInput} up to the parent, which owns the create/update call.
 */
function WebhookEditor({
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  initial: WebhookInput;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: WebhookInput) => void;
}) {
  const [url, setUrl] = useState(initial.url);
  const [label, setLabel] = useState(initial.label ?? "");
  const [events, setEvents] = useState<WebhookEventKind[]>(initial.events);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [error, setError] = useState<string | null>(null);

  const toggleEvent = (kind: WebhookEventKind) => {
    setEvents((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
    );
  };

  const submit = () => {
    setError(null);
    const problem = urlProblem(url);
    if (problem) {
      setError(problem);
      return;
    }
    if (events.length === 0) {
      setError("Pick at least one event to fire on.");
      return;
    }
    const trimmedLabel = label.trim();
    onSubmit({
      url: url.trim(),
      events,
      enabled,
      ...(trimmedLabel ? { label: trimmedLabel } : {}),
    });
  };

  return (
    <div className="rounded-xl border border-clay-500/30 bg-zinc-900/50 p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-zinc-300">URL</span>
          <input
            className={inputCls}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://hooks.slack.com/services/…"
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-zinc-300">Label (optional)</span>
          <input
            className={inputCls}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Team Slack"
          />
        </label>
      </div>

      <fieldset className="mt-3 flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-zinc-300">Fire on</span>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {WEBHOOK_EVENT_KINDS.map((kind) => (
            <label
              key={kind}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1.5 ring-1 ring-zinc-800"
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-clay-500"
                checked={events.includes(kind)}
                onChange={() => toggleEvent(kind)}
              />
              <span className="text-[12.5px] text-zinc-300">{EVENT_LABELS[kind]}</span>
              <code className="ml-auto rounded bg-zinc-800/70 px-1 text-[10px] text-zinc-500">
                {kind}
              </code>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="mt-3 inline-flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-clay-500"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span className="text-[12.5px] text-zinc-300">Enabled</span>
        <span className="text-[11px] text-zinc-600">Off = saved but never delivered.</span>
      </label>

      {error ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg bg-clay-500 px-3 py-1.5 text-[13px] font-medium text-white transition hover:bg-clay-600 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Save webhook
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-[13px] font-medium text-zinc-300 transition hover:bg-zinc-700 disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Inline result of the last "Test" delivery on a row: delivered/status/error. */
function TestResultLine({ result }: { result: WebhookTestResult }) {
  const statusSuffix = result.status != null ? ` (${result.status})` : "";
  return (
    <div
      className={cn(
        "mt-1.5 inline-flex items-center gap-1.5 text-[11px]",
        result.delivered ? "text-emerald-400" : "text-red-300",
      )}
    >
      {result.delivered ? <Check className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {result.delivered
        ? `Delivered${statusSuffix}`
        : `Failed${statusSuffix}${result.error ? ` — ${result.error}` : ""}`}
    </div>
  );
}

/** A fresh webhook for the "add" form: enabled, no events picked yet. */
const NEW_WEBHOOK: WebhookInput = { url: "", events: [], enabled: true };

/** An editing target: "new" for the add form, or an existing webhook. */
type EditTarget = { mode: "new" } | { mode: "edit"; hook: Webhook } | null;

/** The webhook + its last test outcome (keyed by id), shown inline on the row. */
type TestState = { running: boolean; result?: WebhookTestResult };

/**
 * Manage outbound webhooks from Settings. Lists every configured webhook
 * (GET /api/webhooks), and supports add / edit / remove through an inline form plus
 * a per-webhook "Test" button that asks the server to fire a one-off delivery and
 * shows the outcome (delivered / status / error) inline. All writes go through the
 * server, which performs the actual http(s)-only, short-timeout, no-redirect
 * delivery — the browser never fires the outbound request itself.
 *
 * Resilient: an older server that hasn't shipped the /api/webhooks routes 404s, which
 * the api.webhooks.* helpers map to a NotImplementedError — we catch it on the initial
 * list and hide the whole section rather than leaving controls that can't work, exactly
 * like RebuildIndex / ArchiveTransfer degrade on older servers.
 */
export function WebhooksManager() {
  // null = still loading; [] or list once loaded. `unavailable` hides the section on
  // a server without the routes (the initial list 404'd).
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  // Per-webhook test state, keyed by id.
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const reload = useCallback(async () => {
    try {
      const list = await api.webhooks.list();
      setHooks(list);
      setLoadError(null);
    } catch (e) {
      if (e instanceof NotImplementedError) setUnavailable(true);
      else setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.webhooks
      .list()
      .then((list) => {
        if (!cancelled) setHooks(list);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof NotImplementedError) setUnavailable(true);
        else setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = useCallback(
    async (input: WebhookInput) => {
      setBusy(true);
      setLoadError(null);
      try {
        if (editing?.mode === "edit") await api.webhooks.update(editing.hook.id, input);
        else await api.webhooks.create(input);
        await reload();
        setEditing(null);
      } catch (e) {
        if (e instanceof NotImplementedError) setUnavailable(true);
        else setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [editing, reload],
  );

  const handleDelete = useCallback(
    async (hook: Webhook) => {
      setBusy(true);
      setLoadError(null);
      try {
        await api.webhooks.remove(hook.id);
        await reload();
        setPendingDelete(null);
      } catch (e) {
        if (e instanceof NotImplementedError) setUnavailable(true);
        else setLoadError(e instanceof Error ? e.message : String(e));
        // Re-sync in case the delete partially applied.
        void reload();
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const handleTest = useCallback(async (hook: Webhook) => {
    setTests((prev) => ({ ...prev, [hook.id]: { running: true } }));
    try {
      const result = await api.webhooks.test(hook.id);
      setTests((prev) => ({ ...prev, [hook.id]: { running: false, result } }));
    } catch (e) {
      // A test failure shouldn't blow up the section — show it inline on the row.
      const error = e instanceof Error ? e.message : String(e);
      setTests((prev) => ({
        ...prev,
        [hook.id]: { running: false, result: { delivered: false, error } },
      }));
    }
  }, []);

  // Stable key per webhook (id is server-assigned and unique).
  const keyed = useMemo(() => (hooks ?? []).map((h) => ({ k: h.id, h })), [hooks]);

  // Hidden entirely on a server without the routes.
  if (unavailable) return null;

  return (
    <section className="space-y-4 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-5">
      <div className="flex items-center gap-2">
        <WebhookIcon className="h-4 w-4 text-zinc-500" />
        <h2 className="text-[13px] font-semibold text-zinc-200">Webhooks</h2>
        <span className="rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
          {hooks ? hooks.length : "…"}
        </span>
        {!editing ? (
          <button
            onClick={() => setEditing({ mode: "new" })}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-clay-500/15 px-2.5 py-1 text-[12px] font-medium text-clay-300 ring-1 ring-clay-500/30 transition hover:bg-clay-500/25 hover:text-clay-200"
          >
            <Plus className="h-3.5 w-3.5" />
            Add webhook
          </button>
        ) : null}
      </div>
      <p className="-mt-2 text-[11.5px] leading-relaxed text-zinc-600">
        Get a <span className="text-zinc-400">POST to your URL</span> — Slack, Discord, or any
        automation — when a session finishes or stalls, or a budget threshold hits. The server
        delivers over http(s) only, with a short timeout and no redirects.
      </p>

      {loadError ? (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      ) : null}

      {editing?.mode === "new" ? (
        <WebhookEditor
          initial={NEW_WEBHOOK}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSubmit={handleSubmit}
        />
      ) : null}

      {hooks === null && !loadError ? (
        <div className="flex items-center gap-2 py-4 text-[12px] text-zinc-500">
          <Spinner className="h-4 w-4" />
          Loading webhooks…
        </div>
      ) : null}

      {hooks && hooks.length === 0 && !editing ? (
        <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-center text-[12px] text-zinc-600">
          No webhooks configured yet. Add one to get notified in Slack, Discord, or your own tools.
        </div>
      ) : null}

      <ul className="space-y-2">
        {keyed.map(({ k, h }) =>
          editing?.mode === "edit" && editing.hook.id === h.id ? (
            <li key={k}>
              <WebhookEditor
                initial={{ url: h.url, events: h.events, enabled: h.enabled, ...(h.label ? { label: h.label } : {}) }}
                busy={busy}
                onCancel={() => setEditing(null)}
                onSubmit={handleSubmit}
              />
            </li>
          ) : (
            <li
              key={k}
              className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-zinc-100">
                    {h.label || h.url}
                  </span>
                  {h.enabled ? (
                    <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300 ring-1 ring-emerald-500/25">
                      enabled
                    </span>
                  ) : (
                    <span className="rounded-md bg-zinc-800/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                      disabled
                    </span>
                  )}
                </div>
                {h.label ? (
                  <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">{h.url}</div>
                ) : null}
                <div className="mt-1 flex flex-wrap gap-1">
                  {h.events.length === 0 ? (
                    <span className="text-[10.5px] text-zinc-600">no events</span>
                  ) : (
                    h.events.map((e) => (
                      <span
                        key={e}
                        className="rounded bg-zinc-800/70 px-1.5 py-0.5 text-[10px] text-zinc-400"
                      >
                        {e}
                      </span>
                    ))
                  )}
                </div>
                {(() => {
                  const t = tests[h.id];
                  return t && !t.running && t.result ? <TestResultLine result={t.result} /> : null;
                })()}
              </div>

              {pendingDelete === k ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="text-[11px] text-zinc-500">Remove?</span>
                  <button
                    onClick={() => handleDelete(h)}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-md bg-red-500/15 px-2 py-1 text-[11px] font-medium text-red-300 ring-1 ring-red-500/30 transition hover:bg-red-500/25 disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    Yes
                  </button>
                  <button
                    onClick={() => setPendingDelete(null)}
                    disabled={busy}
                    className="rounded-md bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-300 transition hover:bg-zinc-700 disabled:opacity-50"
                  >
                    No
                  </button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => handleTest(h)}
                    disabled={tests[h.id]?.running}
                    className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-clay-300 disabled:opacity-50"
                    title="Send a test delivery"
                  >
                    {tests[h.id]?.running ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    onClick={() => {
                      setPendingDelete(null);
                      setEditing({ mode: "edit", hook: h });
                    }}
                    className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
                    title="Edit webhook"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => setPendingDelete(k)}
                    className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-red-300"
                    title="Remove webhook"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
