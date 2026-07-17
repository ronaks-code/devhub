/**
 * SpatialHub — the React surface for the "office game" view. It owns the PixiJS
 * canvas (via SpatialScene), feeds it live world state, and draws a lightweight
 * HTML HUD on top (source badge, mode controls, hovered-agent card, legend).
 *
 * The canvas does the heavy lifting in WebGL; the HUD is plain DOM so it stays
 * crisp and accessible. Everything below is a renderer over the state stream —
 * no business logic, no persistence.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { departmentLabel, type Agent } from "./contract";
import { SpatialScene, type SceneMode } from "./engine/scene";
import { useWorldState, type FeedSource } from "./stateClient";
import { deptColor, projectAccent } from "./engine/iso";

/** Default live-feed URL (the M1 adapter). Only used when mode=live. */
const LIVE_URL =
  (import.meta.env.VITE_SPATIAL_LIVE_URL as string | undefined) ?? "ws://100.81.240.38:8791/spatial";

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`;
}

export function SpatialHub(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SpatialScene | null>(null);
  const [mode, setMode] = useState<SceneMode>("hub");
  const [hovered, setHovered] = useState<Agent | null>(null);

  // Live feed is opt-in (env flag) and defaults OFF — the UI runs on mock until
  // Ronak deploys the M1 adapter. Honest by construction.
  const feedMode: FeedSource = (import.meta.env.VITE_SPATIAL_FEED as FeedSource) === "live" ? "live" : "mock";
  const { world, source } = useWorldState(feedMode, LIVE_URL);

  // Mount the Pixi scene once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new SpatialScene({
      onEnter: () => setMode("office"),
      onSelectAgent: (a) => setHovered(a),
    });
    sceneRef.current = scene;
    let cancelled = false;
    void scene.init(host).then(() => {
      if (cancelled) scene.destroy();
    });
    return () => {
      cancelled = true;
      scene.destroy();
      sceneRef.current = null;
    };
  }, []);

  // Push every world update into the scene.
  useEffect(() => {
    sceneRef.current?.update(world);
  }, [world]);

  const deptRoomCount = world.rooms.filter((r) => r.kind === "department").length;
  const projRoomCount = world.rooms.filter((r) => r.kind === "project").length;
  const agentCount = world.agents.length;
  const onProject = world.agents.filter((a) => a.project).length;
  const talking = world.edges.filter((e) => e.active).length;

  const depts = useMemo(() => {
    const set = new Map<string, number>();
    for (const a of world.agents) set.set(a.dept, deptColor(a.dept));
    return [...set.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [world.agents]);

  const changeMode = (m: SceneMode) => {
    setMode(m);
    sceneRef.current?.setMode(m);
  };

  return (
    <div className="relative min-w-0 flex-1 overflow-hidden bg-zinc-950">
      {/* WebGL canvas host */}
      <div ref={hostRef} className="absolute inset-0" data-testid="spatial-canvas-host" />

      {/* ── Top bar: source honesty + live counts + view toggle ── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
        <div className="pointer-events-auto flex items-center gap-2">
          <span
            className={
              "rounded-md px-2 py-1 text-[11px] font-semibold ring-1 " +
              (source === "live"
                ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"
                : "bg-amber-500/15 text-amber-300 ring-amber-500/30")
            }
            title={source === "live" ? "Wired to the real M1 OpenClaw feed" : "Simulated data — not the real fleet yet"}
          >
            {source === "live" ? "LIVE · M1" : "MOCK DATA"}
          </span>
          <span className="rounded-md bg-zinc-900/80 px-2 py-1 text-[11px] text-zinc-400 ring-1 ring-zinc-800">
            {deptRoomCount} depts · {projRoomCount} projects · {agentCount} agents ({onProject} on projects) · {talking} talking
          </span>
        </div>
        <div className="pointer-events-auto flex items-center gap-1 rounded-md bg-zinc-900/80 p-1 ring-1 ring-zinc-800">
          {(["hub", "office"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => changeMode(m)}
              className={
                "rounded px-2.5 py-1 text-[11px] font-medium capitalize transition " +
                (mode === m ? "bg-clay-500/20 text-clay-300" : "text-zinc-400 hover:text-zinc-200")
              }
            >
              {m === "hub" ? "Aerial hub" : "Office"}
            </button>
          ))}
        </div>
      </div>

      {/* ── Hovered-agent card ── */}
      {mode === "office" && hovered ? (
        <div className="pointer-events-none absolute bottom-3 left-3 max-w-xs rounded-lg bg-zinc-900/90 p-3 text-[12px] ring-1 ring-zinc-800 backdrop-blur">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: hex(deptColor(hovered.dept)) }} />
            <span className="font-semibold text-zinc-100">{hovered.name}</span>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400">{hovered.role}</span>
          </div>
          <div className="mt-1 text-zinc-400">
            {hovered.assignment ? hovered.assignment : "idle at desk"}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">
            {departmentLabel(hovered.dept)} · {hovered.project ? `on ${hovered.project}` : "home"} · {hovered.status}
          </div>
        </div>
      ) : null}

      {/* ── Legend: room types + departments (office only) ── */}
      {mode === "office" && depts.length > 0 ? (
        <div className="pointer-events-none absolute bottom-3 right-3 rounded-lg bg-zinc-900/80 p-2.5 text-[11px] ring-1 ring-zinc-800">
          <div className="mb-1 font-semibold text-zinc-300">Room types</div>
          <div className="mb-2 grid gap-1">
            <div className="flex items-center gap-1.5 text-zinc-400">
              <span className="inline-block h-2.5 w-3.5 rounded-sm border-2 border-solid" style={{ borderColor: hex(deptColor("vulcan")) }} />
              <span>Department (home base)</span>
            </div>
            <div className="flex items-center gap-1.5 text-zinc-400">
              <span className="inline-block h-2.5 w-3.5 rounded-sm border-2 border-dashed" style={{ borderColor: hex(projectAccent()) }} />
              <span>Project (cross-dept team)</span>
            </div>
          </div>
          <div className="mb-1 font-semibold text-zinc-300">Departments</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {depts.map(([dept, color]) => (
              <div key={dept} className="flex items-center gap-1.5 text-zinc-400">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: hex(color) }} />
                <span className="capitalize">{dept}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 mb-1 border-t border-zinc-800 pt-1.5 font-semibold text-zinc-300">
            Connections <span className="font-normal text-zinc-500">(hover an agent)</span>
          </div>
          <div className="grid gap-1">
            <div className="flex items-center gap-1.5 text-zinc-400">
              <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: "#fcd34d", boxShadow: "0 0 4px #fcd34d" }} />
              <span>Leader → report (vertical)</span>
            </div>
            <div className="flex items-center gap-1.5 text-zinc-400">
              <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: "#38bdf8", boxShadow: "0 0 4px #38bdf8" }} />
              <span>Peer ↔ peer (lateral)</span>
            </div>
          </div>
          <div className="mt-2 border-t border-zinc-800 pt-1.5 text-[10px] text-zinc-500">
            drag to pan · scroll to zoom · hover a character for detail
          </div>
        </div>
      ) : null}

      {/* ── Hub controls hint ── */}
      {mode === "hub" ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-lg bg-zinc-900/80 px-3 py-2 text-center text-[12px] text-zinc-400 ring-1 ring-zinc-800">
          Drive with <kbd className="rounded bg-zinc-800 px-1">WASD</kbd> to the OpenClaw building, then press{" "}
          <kbd className="rounded bg-zinc-800 px-1">E</kbd> to enter
        </div>
      ) : null}
    </div>
  );
}

export default SpatialHub;
