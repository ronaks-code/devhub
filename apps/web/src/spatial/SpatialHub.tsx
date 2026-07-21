import { useEffect, useState } from "react";
import { OfficeVisualizer } from "./OfficeVisualizer";
import { BlueprintOffice } from "./BlueprintOffice";
import { useWorldState } from "./stateClient";
import { cn } from "../lib/utils";

type Renderer = "blueprint" | "nameplates";
const RENDERER_KEY = "devhub:spatial-renderer";

/** Read the persisted renderer choice (blueprint by default, §3.5). */
function readRenderer(): Renderer {
  if (typeof window === "undefined") return "blueprint";
  try {
    return localStorage.getItem(RENDERER_KEY) === "nameplates" ? "nameplates" : "blueprint";
  } catch {
    return "blueprint";
  }
}

/**
 * Spatial route (Aurora Cockpit §3.5). Both renderers draw the SAME live
 * `WorldState` (mock feed today, the M1 adapter later): Blueprint (default) is the
 * architectural floor plan; Nameplates is a card-grid view of the identical world,
 * kept as a one-click rollback. Neither invents its own roster or palette. The
 * renderer choice persists in localStorage.
 */
export function SpatialHub(): React.JSX.Element {
  const [renderer, setRenderer] = useState<Renderer>(readRenderer);
  const { world, source } = useWorldState("mock");

  useEffect(() => {
    try {
      localStorage.setItem(RENDERER_KEY, renderer);
    } catch {
      /* storage may be unavailable; the in-memory choice still holds */
    }
  }, [renderer]);

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="dh-aurora-bg--soft flex shrink-0 items-center gap-2 border-b border-[var(--dh-border-subtle)] px-6 py-2">
        <div role="tablist" aria-label="Office renderer" className="glass-card inline-flex items-center p-0.5">
          {([
            ["blueprint", "Blueprint"],
            ["nameplates", "Nameplates"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={renderer === id}
              onClick={() => setRenderer(id)}
              className={cn(
                "rounded-[8px] px-2.5 py-1 text-[11.5px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dh-focus)]",
                renderer === id
                  ? "bg-[var(--dh-rail-active)] text-[var(--dh-text-strong)] ring-1 ring-[var(--dh-glass-border-hi)]"
                  : "text-[var(--dh-text-muted)] hover:text-[var(--dh-text)]",
              )}
              title={id === "blueprint" ? "Blueprint office — live world" : "Classic nameplate grid (rollback)"}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {renderer === "blueprint" ? (
        <BlueprintOffice world={world} source={source} />
      ) : (
        <OfficeVisualizer world={world} source={source} />
      )}
    </div>
  );
}

export default SpatialHub;
