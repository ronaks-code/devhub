import { useCallback, useEffect, useRef } from "react";
import { Keyboard, X } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * A keyboard-shortcut cheat-sheet. Pressing "?" anywhere (outside a text field)
 * opens it; Escape, the close button, or a click on the backdrop closes it.
 *
 * Plain words: a quick reminder card of every keyboard trick the app knows —
 * search, the command palette, jumping between lists, etc. — so you don't have to
 * memorize them. It's modal and accessible: focus is trapped inside while open,
 * it announces itself as a dialog, and closing hands focus back to wherever you
 * were.
 *
 * The list below is the REAL set wired across App.tsx and the hooks (verified at
 * build time, not invented) — keep it in lockstep when shortcuts change.
 */

interface Shortcut {
  /** The key combo, pre-split into chips (e.g. ["⌘", "K"]). */
  keys: string[];
  /** What the combo does. */
  label: string;
}

interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

/** The actual shortcuts the app binds. Grouped for a scannable layout. */
const GROUPS: ShortcutGroup[] = [
  {
    title: "Global",
    items: [
      { keys: ["⌘", "K"], label: "Search sessions" },
      { keys: ["⌘", "⇧", "P"], label: "Command palette" },
      { keys: ["⌘", "P"], label: "Switch project" },
      { keys: ["?"], label: "This shortcut cheat-sheet" },
      { keys: ["Esc"], label: "Close any palette / overlay" },
    ],
  },
  {
    title: "Lists (projects & sessions)",
    items: [
      { keys: ["J"], label: "Move down" },
      { keys: ["K"], label: "Move up" },
      { keys: ["↑", "↓"], label: "Move up / down" },
      { keys: ["Home", "End"], label: "Jump to first / last" },
      { keys: ["Enter"], label: "Open the focused item" },
    ],
  },
  {
    title: "Transcript",
    items: [
      { keys: ["⌘", "F"], label: "Find in this transcript" },
      { keys: ["Alt", "E"], label: "Next tool error" },
      { keys: ["Alt", "⇧", "E"], label: "Previous tool error" },
    ],
  },
  {
    title: "Approvals (live chat)",
    items: [
      { keys: ["A"], label: "Allow once" },
      { keys: ["S"], label: "Allow for the session" },
      { keys: ["D"], label: "Deny" },
      { keys: ["E"], label: "Edit the request" },
      { keys: ["J", "K"], label: "Step through queued requests" },
    ],
  },
];

/** Selector matching every focusable node, for the focus trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] font-medium text-zinc-200 shadow-sm">
      {children}
    </kbd>
  );
}

export function ShortcutOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // The element focused before we opened, so we can restore it on close.
  const restoreRef = useRef<HTMLElement | null>(null);

  // On open: remember the prior focus and move focus into the dialog. On close:
  // hand focus back. Guarded so it only fires on the open→close transitions.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = (document.activeElement as HTMLElement) ?? null;
    // Defer so the panel is mounted before we focus its close button.
    const raf = requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      // Restore focus to where the user was when the dialog closes.
      restoreRef.current?.focus?.();
    };
  }, [open]);

  // Escape to close + a focus trap that keeps Tab cycling within the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
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
      // Wrap focus at the ends so Tab never escapes the dialog.
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
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 p-4 pt-[10vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        // Click-out: only when the press starts on the backdrop itself.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-overlay-title"
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl shadow-black/50"
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 px-5 py-3">
          <Keyboard className="h-4 w-4 text-clay-400" />
          <h2 id="shortcut-overlay-title" className="text-[14px] font-semibold text-zinc-100">
            Keyboard shortcuts
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
            aria-label="Close shortcuts"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-6 overflow-y-auto px-5 py-5 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.title} className="min-w-0">
              <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-500">
                {group.title}
              </h3>
              <ul className="space-y-1.5">
                {group.items.map((s, i) => (
                  <li key={i} className="flex items-center gap-3">
                    <span className="flex items-center gap-1">
                      {s.keys.map((k, j) => (
                        <Kbd key={j}>{k}</Kbd>
                      ))}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-300">
                      {s.label}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div
          className={cn(
            "border-t border-zinc-800 px-5 py-2.5 text-[11px] text-zinc-600",
          )}
        >
          Press <Kbd>?</Kbd> any time to open this. <Kbd>Esc</Kbd> to close.
        </div>
      </div>
    </div>
  );
}
