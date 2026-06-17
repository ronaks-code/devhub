import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";

/**
 * A React error boundary: catches a render error ANYWHERE in the wrapped tree and
 * shows a clean, recoverable fallback instead of a blank white screen. Two ways
 * out: "Try again" resets the boundary (re-renders the same children — good when
 * the error was transient, e.g. a momentary bad prop), and "Reload" does a full
 * page reload (the nuclear option when state is wedged).
 *
 * Class component on purpose — `getDerivedStateFromError` / `componentDidCatch`
 * have no hooks equivalent. Kept small and dependency-light; it wraps the app
 * content in App.tsx so any downstream crash is contained.
 */
interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console for debugging; the UI already shows the message.
    // (No remote logging here — the app has no telemetry sink.)
    // eslint-disable-next-line no-console
    console.error("ErrorBoundary caught an error:", error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  private reload = (): void => {
    if (typeof window !== "undefined") window.location.reload();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-zinc-950 px-8 text-center">
        <div className="text-amber-400">
          <AlertTriangle className="h-10 w-10" />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="text-sm font-semibold text-zinc-200">Something went wrong</div>
          <div className="max-w-md text-xs leading-relaxed text-zinc-500">
            The view hit an unexpected error. Try again to re-render, or reload the page
            if it keeps happening.
          </div>
        </div>
        {error.message ? (
          <pre className="max-w-md overflow-x-auto rounded-lg bg-zinc-900 px-3 py-2 text-left font-mono text-[11px] leading-relaxed text-red-300 ring-1 ring-zinc-800">
            {error.message}
          </pre>
        ) : null}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="inline-flex items-center gap-1.5 rounded-lg bg-clay-500/15 px-3 py-1.5 text-[12px] font-medium text-clay-300 ring-1 ring-clay-500/30 transition hover:bg-clay-500/25"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Try again
          </button>
          <button
            type="button"
            onClick={this.reload}
            className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-[12px] font-medium text-zinc-400 ring-1 ring-zinc-800 transition hover:text-zinc-200"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reload
          </button>
        </div>
      </div>
    );
  }
}
