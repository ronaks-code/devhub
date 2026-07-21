import { useEffect, useRef } from "react";
import {
  Command as CommandIcon,
  DatabaseZap,
  Keyboard,
  LayoutDashboard,
  MessagesSquare,
  Radio,
  Search,
  Sparkles,
} from "lucide-react";
import { DeckMark } from "./DeckMark";
import { readCompat, writeCompat } from "../lib/compat-storage";

/**
 * First-run / onboarding experience.
 *
 * Plain words: the very first time someone opens Claude UI, this shows a friendly
 * welcome card explaining the three things the app is for and the handful of
 * keyboard tricks worth knowing. A "Get started" button dismisses it and sets a
 * localStorage flag so a RETURNING user never sees it again. It also self-hides if
 * there's already indexed history (sessionCount > 0) — that user clearly isn't new,
 * so we never block them with a welcome screen on a reload.
 *
 * It's modal + accessible, mirroring ShortcutOverlay: focus is trapped while open,
 * it announces itself as a dialog, Escape / the backdrop / "Get started" all close
 * it, and closing restores focus to wherever the user was.
 */

const SEEN_KEY = "devhub:onboarded";

/** Has the user dismissed onboarding before? SSR/quota guarded, like UI-state persistence. */
export function hasSeenOnboarding(): boolean {
  if (typeof window === "undefined") return true; // SSR: never block render
  // A genuine new user has no stored flag (readCompat → null) → show onboarding.
  return readCompat(SEEN_KEY) === "1";
}

/** Mark onboarding as seen so it never shows again. Non-fatal on storage errors. */
export function markOnboardingSeen(): void {
  writeCompat(SEEN_KEY, "1");
}

/** Selector matching every focusable node, for the focus trap (matches ShortcutOverlay). */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The three core things the app is for, shown as a quick orientation. */
const PILLARS: { icon: React.ReactNode; title: string; body: string }[] = [
  {
    icon: <Search className="h-4 w-4" />,
    title: "Browse past chats",
    body: "Read every Claude Code session across all your projects, search by content, and pick up where you left off.",
  },
  {
    icon: <Sparkles className="h-4 w-4" />,
    title: "Chat live",
    body: "Start a new Claude Code session in any project's working directory — approvals, diffs, and tools, right here.",
  },
  {
    icon: <LayoutDashboard className="h-4 w-4" />,
    title: "Dashboard & oversight",
    body: "Watch running sessions on the Live Ops board and track tokens, spend, and activity across everything.",
  },
];

/** The handful of shortcuts worth knowing on day one (a subset of ShortcutOverlay). */
const SHORTCUTS: { keys: string[]; label: string; icon: React.ReactNode }[] = [
  { keys: ["⌘", "K"], label: "Search sessions", icon: <Search className="h-3.5 w-3.5" /> },
  { keys: ["⌘", "⇧", "P"], label: "Command palette", icon: <CommandIcon className="h-3.5 w-3.5" /> },
  { keys: ["?"], label: "All keyboard shortcuts", icon: <Keyboard className="h-3.5 w-3.5" /> },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] font-medium text-zinc-200 shadow-sm">
      {children}
    </kbd>
  );
}

/**
 * The welcome overlay itself. `open` is controlled by the host (App), which gates
 * it on `!hasSeenOnboarding()` AND an empty index. `onDismiss` should mark it seen
 * and flip the host's open state.
 */
export function FirstRun({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLButtonElement>(null);
  // The element focused before we opened, so we can restore it on close.
  const restoreRef = useRef<HTMLElement | null>(null);

  // On open: remember the prior focus and move focus onto the primary CTA. On
  // close: hand focus back. Mirrors ShortcutOverlay's transition handling.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = (document.activeElement as HTMLElement) ?? null;
    const raf = requestAnimationFrame(() => ctaRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      restoreRef.current?.focus?.();
    };
  }, [open]);

  // Escape to dismiss + a focus trap that keeps Tab cycling within the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null,
      );
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onDismiss]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/60 p-4 pt-[8vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        // Click-out dismisses — but only when the press starts on the backdrop.
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-run-title"
        className="glass-hi flex max-h-[84vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-[var(--dh-surface)] shadow-2xl shadow-black/50"
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--dh-border-subtle)] px-6 py-4">
          <DeckMark size={20} className="shrink-0" />
          <h2 id="first-run-title" className="text-[15px] font-semibold text-[var(--dh-text-strong)]">
            Welcome to DevHub
          </h2>
        </div>

        <div className="overflow-y-auto px-6 py-5">
          <p className="text-[12.5px] leading-relaxed text-[var(--dh-text-muted)]">
            Your personal dev hub — browse Claude &amp; Codex sessions, start new chats, track usage across all your AI tools.
          </p>

          <div className="mt-4 flex flex-col gap-3">
            {PILLARS.map((p) => (
              <div key={p.title} className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] ring-1 ring-[var(--dh-glass-border-hi)]">
                  {p.icon}
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-[var(--dh-text-strong)]">{p.title}</div>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--dh-text-muted)]">{p.body}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5 rounded-xl border border-[var(--dh-border-subtle)] bg-[var(--dh-control)]/60 px-4 py-3">
            <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--dh-text-muted)]">
              Handy shortcuts
            </div>
            <ul className="space-y-1.5">
              {SHORTCUTS.map((s) => (
                <li key={s.label} className="flex items-center gap-3">
                  <span className="flex items-center gap-1">
                    {s.keys.map((k, j) => (
                      <Kbd key={j}>{k}</Kbd>
                    ))}
                  </span>
                  <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--dh-text)]">
                    <span className="text-[var(--dh-text-dim)]">{s.icon}</span>
                    {s.label}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--dh-border-subtle)] px-6 py-4">
          <span className="text-[11px] text-[var(--dh-text-dim)]">You can reopen shortcuts any time with ?</span>
          <button
            ref={ctaRef}
            type="button"
            onClick={onDismiss}
            style={{ background: "var(--dh-grad-brand)" }}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-1.5 text-[13px] font-medium text-white transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
          >
            Get started
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Empty-state shown in the Browse projects column when the index has nothing yet.
 * Distinguishes "still indexing" (a spinner + reassurance) from "indexed but empty"
 * (a pointer to Settings → Rebuild index, in case discovery missed the transcripts).
 * Additive: ProjectsPane keeps its own terse "No projects" line; this richer panel
 * is only mounted by the host when it knows the whole index is empty.
 */
export function EmptyIndexHint({
  indexing,
  onOpenSettings,
}: {
  /** True while a background index pass is running (App's `progress` is non-null). */
  indexing: boolean;
  /** Jump to Settings (where Rebuild index lives), when the host wires it. */
  onOpenSettings?: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-zinc-700">
        {indexing ? <DatabaseZap className="h-10 w-10" /> : <MessagesSquare className="h-10 w-10" />}
      </div>
      <div className="text-sm font-medium text-zinc-400">
        {indexing ? "Indexing your sessions…" : "No projects yet"}
      </div>
      <p className="max-w-xs text-xs leading-relaxed text-zinc-600">
        {indexing ? (
          <>
            We're reading your Claude Code transcripts from{" "}
            <code className="text-zinc-500">~/.claude/projects</code>. Projects and
            chats will appear here as they're discovered.
          </>
        ) : (
          <>
            Once you've run Claude Code somewhere, its sessions show up here. If you
            expected history, try rebuilding the search index.
          </>
        )}
      </p>
      {!indexing && onOpenSettings ? (
        <button
          type="button"
          onClick={onOpenSettings}
          className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-[12px] font-medium text-zinc-200 ring-1 ring-zinc-700 transition hover:bg-zinc-800 hover:text-zinc-100"
        >
          <DatabaseZap className="h-3.5 w-3.5" />
          Open Settings to rebuild index
        </button>
      ) : null}
      {indexing ? (
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-clay-300">
          <Radio className="h-3.5 w-3.5 animate-pulse" />
          Live — no need to refresh
        </div>
      ) : null}
    </div>
  );
}
