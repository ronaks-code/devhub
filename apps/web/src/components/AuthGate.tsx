import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Hexagon, KeyRound, LogOut } from "lucide-react";
import { api, getToken, onUnauthorized, setToken, UnauthorizedError } from "../lib/api";
import { Spinner } from "./ui";
import { cn } from "../lib/utils";

/**
 * Remote/mobile access gate. The server can require a bearer token (whoever runs
 * it sets one); when it does, every protected route answers 401. This component
 * wraps the whole app:
 *
 *  - On the local no-token default, calls succeed and the gate is fully
 *    transparent — it just renders {@link children} with no chrome.
 *  - The moment any API call (REST, SSE, or WS upgrade) comes back 401, the gate
 *    flips to a clean login screen asking for the access token.
 *  - A submitted token is stored in localStorage (key `claude-ui-token`, via
 *    {@link setToken}) so api.ts/ws.ts re-attach it to every subsequent request,
 *    then we re-probe the server and, on success, drop back to the app.
 *
 * Plain words: if you open this UI from your phone over the internet and the
 * server is locked, you get a little "paste your access token" screen; once it's
 * right you're in, and it remembers the token next time. On your own machine
 * (nothing's locked) you never see any of this.
 */

type Phase =
  // No 401 seen yet — render children. (On the local default we stay here forever.)
  | "open"
  // A 401 fired (or a fresh probe failed) — show the login screen.
  | "locked"
  // Verifying a just-entered token against the server.
  | "verifying";

export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("open");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Any 401 from anywhere in the app (api.ts notifies all listeners) locks the
  // gate. Subscribing once on mount means a 401 on a background poll flips the UI
  // even if the user wasn't awaiting that exact call.
  useEffect(() => {
    return onUnauthorized(() => {
      setPhase((p) => (p === "verifying" ? p : "locked"));
    });
  }, []);

  // Seed the input with any stored token (e.g. one that just went stale) so the
  // user can tweak rather than retype it.
  useEffect(() => {
    if (phase === "locked") setValue((v) => v || getToken() || "");
  }, [phase]);

  const submit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const token = value.trim();
      if (!token) {
        setError("Enter your access token.");
        return;
      }
      setError(null);
      setPhase("verifying");
      // Store first so the probe (and everything after) carries the token.
      setToken(token);
      try {
        await api.health();
        setPhase("open");
      } catch (err) {
        // Still 401 → wrong token; anything else → server reachable but erroring,
        // which we treat as "let them in" (the gate only guards the 401 case).
        if (err instanceof UnauthorizedError) {
          setError("That token was rejected. Check it and try again.");
          setPhase("locked");
        } else {
          setPhase("open");
        }
      }
    },
    [value],
  );

  if (phase === "open") return <>{children}</>;

  const verifying = phase === "verifying";
  return (
    <div className="flex h-full items-center justify-center bg-zinc-950 px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-xl ring-1 ring-zinc-800/60"
      >
        <div className="mb-4 flex items-center gap-2.5">
          <Hexagon className="h-5 w-5 fill-clay-500/20 text-clay-500" />
          <span className="text-base font-semibold tracking-tight text-zinc-100">Claude UI</span>
        </div>
        <h1 className="text-[15px] font-semibold text-zinc-100">Access token required</h1>
        <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-500">
          This server is locked for remote access. Paste the access token to continue —
          it&rsquo;s saved on this device so you won&rsquo;t be asked again.
        </p>

        <label className="mt-4 block">
          <span className="sr-only">Access token</span>
          <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 focus-within:border-clay-500/50 focus-within:ring-1 focus-within:ring-clay-500/30">
            <KeyRound className="h-4 w-4 shrink-0 text-zinc-600" />
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              placeholder="Access token"
              disabled={verifying}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:opacity-60"
            />
          </div>
        </label>

        {error ? (
          <p role="alert" className="mt-2 text-[12px] text-red-400">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={verifying}
          className={cn(
            "mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-clay-500/15 px-3 py-2 text-[13px] font-medium text-clay-300 ring-1 ring-clay-500/30 transition",
            "hover:bg-clay-500/25 hover:text-clay-200 disabled:pointer-events-none disabled:opacity-60",
          )}
        >
          {verifying ? (
            <>
              <Spinner className="h-3.5 w-3.5" />
              Checking…
            </>
          ) : (
            "Unlock"
          )}
        </button>
      </form>
    </div>
  );
}

/**
 * A small "log out" affordance — clears the stored token and re-locks the gate by
 * forcing a fresh 401 probe. Drop it in a header/menu where signing out makes
 * sense. Renders nothing when no token is stored (the local default), so it never
 * clutters an un-gated session.
 */
export function LogoutButton({ className }: { className?: string }) {
  // Re-read on each render so the button appears/disappears as the token changes
  // (e.g. right after a successful unlock). Cheap — it's a single localStorage read.
  const hasToken = !!getToken();
  if (!hasToken) return null;
  return (
    <button
      type="button"
      onClick={() => {
        setToken(null);
        // Probe so api.ts emits a 401 (when the server is still locked) and the
        // gate re-locks. On an unlocked server this simply succeeds and we stay in.
        void api.health().catch(() => {});
      }}
      title="Log out (clear the saved access token)"
      aria-label="Log out"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200",
        className,
      )}
    >
      <LogOut className="h-3.5 w-3.5" />
      Log out
    </button>
  );
}
