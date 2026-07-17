/**
 * SpatialScene — the PixiJS renderer. It owns a WebGL canvas and turns a
 * `WorldState` into a living 2.5D isometric office you can pan/zoom around, plus
 * an aerial "hub" you travel before entering the OpenClaw building.
 *
 * Design choices that keep it light on the M5:
 * - One WebGL context, containers reused across ticks (reconcile, don't rebuild).
 * - Positions derived every frame from the layout + per-agent motion phase, so
 *   there's no physics engine — just cheap lerps.
 * - Two "modes" share one camera: `hub` (aerial, you drive an avatar to the
 *   building) and `office` (the iso room scene). Entering zooms between them.
 *
 * This file is the only place that touches Pixi; math lives in `iso.ts`.
 */

import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import type { Agent, WorldState } from "../contract";
import {
  TILE_W,
  TILE_H,
  agentGridPosition,
  computeLayout,
  deptColor,
  toScreen,
  type WorldLayout,
} from "./iso";

export type SceneMode = "hub" | "office";

interface AgentView {
  container: Container;
  body: Graphics;
  label: Text;
  statusDot: Graphics;
  /** 0..1 motion phase for a moving leader. */
  phase: number;
}

interface RoomView {
  container: Container;
  floor: Graphics;
  label: Text;
}

const labelStyle = (size: number, color = 0xe5e7eb) =>
  new TextStyle({ fontFamily: "ui-sans-serif, system-ui, sans-serif", fontSize: size, fill: color, fontWeight: "600" });

/**
 * Compact per-character label. The room title already carries the dept·project,
 * so under each character we only need the differentiator: "lead" for a leader,
 * otherwise the trailing token of its name (e.g. `apollo-capture-2` → "2"). Full
 * name + assignment live on the hover card, so this stays legible when a room is
 * crowded. Falls back to the full name if there's nothing shorter.
 */
function shortAgentLabel(agent: Agent): string {
  if (agent.role === "leader") return "lead";
  const tail = agent.name.split("-").pop();
  return tail && tail !== agent.name ? tail : agent.name;
}

export interface SceneCallbacks {
  /** Fired when the player enters the building from the hub. */
  onEnter?: () => void;
  /** Fired when the hovered/selected agent changes (for the HUD). */
  onSelectAgent?: (agent: Agent | null) => void;
}

export class SpatialScene {
  readonly app: Application;
  private world: WorldState = { rev: 0, ts: 0, agents: [], edges: [], rooms: [] };
  private layout: WorldLayout | null = null;
  private mode: SceneMode = "hub";

  // Camera: a single container we translate/scale. Children are layered.
  private camera = new Container();
  private floorLayer = new Container();
  private edgeLayer = new Container();
  private roomLayer = new Container();
  private agentLayer = new Container();

  // Hub-only actors.
  private hubLayer = new Container();
  private building!: Container;
  private avatar!: Container;
  private avatarPos = { x: 0, y: -220 };
  private keys = new Set<string>();
  private enterHint!: Text;

  private roomViews = new Map<string, RoomView>();
  private agentViews = new Map<string, AgentView>();
  private edgeGfx = new Graphics();

  private cb: SceneCallbacks;
  private destroyed = false;
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };

  constructor(cb: SceneCallbacks = {}) {
    this.app = new Application();
    this.cb = cb;
  }

  async init(container: HTMLElement): Promise<void> {
    await this.app.init({
      background: 0x0a0a0b,
      antialias: true,
      resizeTo: container,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    container.appendChild(this.app.canvas);

    // Layer order matters: room floors first, then edge lines ON TOP of the
    // floors (otherwise the floors paint over the "talking" lines), then agents
    // on top of everything so characters are never occluded.
    this.camera.addChild(this.floorLayer, this.roomLayer, this.edgeLayer, this.agentLayer, this.hubLayer);
    this.edgeLayer.addChild(this.edgeGfx);
    this.app.stage.addChild(this.camera);

    this.buildHub();
    this.centerCameraOnScreen();
    this.installInput();
    this.app.ticker.add(() => this.frame());
    this.setMode("hub");
  }

  destroy(): void {
    this.destroyed = true;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    if (this.app.renderer) this.app.destroy(true, { children: true });
  }

  /** Feed a new world; reconcile display objects. */
  update(world: WorldState): void {
    this.world = world;
    this.layout = computeLayout(world);
    this.reconcileRooms();
    this.reconcileAgents();
  }

  setMode(mode: SceneMode): void {
    this.mode = mode;
    this.hubLayer.visible = mode === "hub";
    this.floorLayer.visible = mode === "office";
    this.roomLayer.visible = mode === "office";
    this.edgeLayer.visible = mode === "office";
    this.agentLayer.visible = mode === "office";
    if (mode === "office") this.fitOfficeToView();
    else this.centerCameraOnScreen();
  }

  getMode(): SceneMode {
    return this.mode;
  }

  // ── Hub (aerial travel) ────────────────────────────────────────────────
  private buildHub(): void {
    // Ground: a large muted grid to give the sense of a place.
    const ground = new Graphics();
    ground.rect(-900, -700, 1800, 1400).fill(0x111114);
    for (let gx = -900; gx <= 900; gx += 90) ground.moveTo(gx, -700).lineTo(gx, 700);
    for (let gy = -700; gy <= 700; gy += 90) ground.moveTo(-900, gy).lineTo(900, gy);
    ground.stroke({ width: 1, color: 0x1c1c22 });
    this.hubLayer.addChild(ground);

    // The OpenClaw HQ building — a labeled iso block you walk to and enter.
    this.building = new Container();
    const b = new Graphics();
    // iso top
    b.poly([0, -70, 130, 5, 0, 80, -130, 5]).fill(0x1f2937).stroke({ width: 2, color: 0x3b82f6 });
    // left face
    b.poly([-130, 5, 0, 80, 0, 150, -130, 75]).fill(0x111827);
    // right face
    b.poly([130, 5, 0, 80, 0, 150, 130, 75]).fill(0x0b1220);
    this.building.addChild(b);
    const bl = new Text({ text: "OpenClaw HQ", style: labelStyle(16, 0x93c5fd) });
    bl.anchor.set(0.5);
    bl.position.set(0, -95);
    this.building.addChild(bl);
    this.building.position.set(0, 0);
    this.hubLayer.addChild(this.building);

    // Player avatar — a little "car"/token you drive with WASD/arrows or click.
    this.avatar = new Container();
    const a = new Graphics();
    a.circle(0, 0, 12).fill(0xff6b3d).stroke({ width: 2, color: 0xffffff });
    a.rect(-4, -20, 8, 8).fill(0xffffff); // a nub so orientation reads
    this.avatar.addChild(a);
    const you = new Text({ text: "you", style: labelStyle(11, 0xfca5a5) });
    you.anchor.set(0.5);
    you.position.set(0, 20);
    this.avatar.addChild(you);
    this.avatar.position.set(this.avatarPos.x, this.avatarPos.y);
    this.hubLayer.addChild(this.avatar);

    this.enterHint = new Text({ text: "▲ walk to OpenClaw HQ and press E to enter", style: labelStyle(13, 0x9ca3af) });
    this.enterHint.anchor.set(0.5);
    this.enterHint.position.set(0, 240);
    this.hubLayer.addChild(this.enterHint);
  }

  private updateHub(dt: number): void {
    const speed = 3.2 * dt;
    if (this.keys.has("w") || this.keys.has("arrowup")) this.avatarPos.y -= speed;
    if (this.keys.has("s") || this.keys.has("arrowdown")) this.avatarPos.y += speed;
    if (this.keys.has("a") || this.keys.has("arrowleft")) this.avatarPos.x -= speed;
    if (this.keys.has("d") || this.keys.has("arrowright")) this.avatarPos.x += speed;
    this.avatar.position.set(this.avatarPos.x, this.avatarPos.y);

    const near = Math.hypot(this.avatarPos.x - this.building.x, this.avatarPos.y - this.building.y) < 130;
    this.enterHint.visible = near;
    this.enterHint.text = near ? "press E to enter OpenClaw HQ" : "▲ drive to OpenClaw HQ (WASD)";
    if (near && this.keys.has("e")) {
      this.keys.delete("e");
      this.enterOffice();
    }
  }

  private enterOffice(): void {
    this.setMode("office");
    this.cb.onEnter?.();
  }

  // ── Office (iso rooms) ─────────────────────────────────────────────────
  private reconcileRooms(): void {
    if (!this.layout) return;
    const seen = new Set<string>();
    for (const [id, rl] of this.layout.rooms) {
      seen.add(id);
      let view = this.roomViews.get(id);
      if (!view) {
        const c = new Container();
        const floor = new Graphics();
        const label = new Text({ text: rl.room.label, style: labelStyle(13) });
        label.anchor.set(0.5, 1);
        c.addChild(floor, label);
        this.roomLayer.addChild(c);
        view = { container: c, floor, label };
        this.roomViews.set(id, view);
      }
      // (Re)draw the iso floor tiles for the room's footprint.
      const g = view.floor;
      g.clear();
      const color = deptColor(rl.room.dept);
      for (let dc = 0; dc < rl.cols; dc++) {
        for (let dr = 0; dr < rl.rows; dr++) {
          const p = toScreen(rl.origin.col + dc, rl.origin.row + dr);
          const shade = (dc + dr) % 2 === 0 ? 0x17171c : 0x131317;
          g.poly([p.x, p.y, p.x + TILE_W / 2, p.y + TILE_H / 2, p.x, p.y + TILE_H, p.x - TILE_W / 2, p.y + TILE_H / 2]).fill(shade);
        }
      }
      // Room accent border around the footprint.
      const o = toScreen(rl.origin.col, rl.origin.row);
      const tr = toScreen(rl.origin.col + rl.cols, rl.origin.row);
      const bl2 = toScreen(rl.origin.col, rl.origin.row + rl.rows);
      const br = toScreen(rl.origin.col + rl.cols, rl.origin.row + rl.rows);
      g.poly([o.x, o.y, tr.x, tr.y, br.x, br.y, bl2.x, bl2.y]).stroke({ width: 2, color, alpha: 0.7 });
      // Sit the room title above the room's top corner so it never collides with
      // the first row of characters.
      const c0 = toScreen(rl.center.col, rl.origin.row - 1.1);
      view.label.position.set(c0.x, c0.y);
      view.label.text = rl.room.label;
    }
    for (const [id, view] of this.roomViews) {
      if (!seen.has(id)) {
        view.container.destroy({ children: true });
        this.roomViews.delete(id);
      }
    }
  }

  private reconcileAgents(): void {
    const present = new Map(this.world.agents.map((a) => [a.id, a]));
    for (const [id, agent] of present) {
      let view = this.agentViews.get(id);
      if (!view) {
        const c = new Container();
        const body = new Graphics();
        const label = new Text({ text: shortAgentLabel(agent), style: labelStyle(10, 0xcbd5e1) });
        label.anchor.set(0.5, 0);
        label.position.set(0, 6);
        const statusDot = new Graphics();
        statusDot.position.set(0, -30);
        c.addChild(body, statusDot, label);
        c.eventMode = "static";
        c.cursor = "pointer";
        c.on("pointerover", () => this.cb.onSelectAgent?.(present.get(id) ?? null));
        this.agentLayer.addChild(c);
        view = { container: c, body, label, statusDot, phase: 0 };
        this.agentViews.set(id, view);
      }
      this.drawAgentBody(view, agent);
      view.label.text = shortAgentLabel(agent);
    }
    for (const [id, view] of this.agentViews) {
      if (!present.has(id)) {
        view.container.destroy({ children: true });
        this.agentViews.delete(id);
      }
    }
  }

  private drawAgentBody(view: AgentView, agent: Agent): void {
    const g = view.body;
    g.clear();
    const color = deptColor(agent.dept);
    const isLeader = agent.role === "leader";
    // Simple "person": a rounded body + head. Leaders are taller with a ring.
    const h = isLeader ? 26 : 20;
    g.roundRect(-7, -h, 14, h, 6).fill(color);
    g.circle(0, -h - 6, 6).fill(0xf5f5f4); // head
    if (isLeader) g.circle(0, -h - 6, 9).stroke({ width: 2, color: 0xfacc15 }); // leader halo

    const dotColors: Record<string, number> = {
      idle: 0x6b7280,
      working: 0x34d399,
      talking: 0x60a5fa,
      moving: 0xfbbf24,
      blocked: 0xf87171,
      done: 0x4b5563,
    };
    view.statusDot.clear();
    view.statusDot.circle(0, 0, 4).fill(dotColors[agent.status] ?? 0x6b7280);
    view.statusDot.position.set(0, -h - 16);
  }

  // ── Per-frame ──────────────────────────────────────────────────────────
  private frame(): void {
    const dt = this.app.ticker.deltaTime;
    if (this.mode === "hub") {
      this.updateHub(dt);
      return;
    }
    if (!this.layout) return;

    // Animate active edges + move leaders along them.
    this.edgeGfx.clear();
    for (const a of this.world.agents) {
      const view = this.agentViews.get(a.id);
      if (!view) continue;
      // A moving leader glides toward the target but STOPS just short (0.82) so it
      // stands beside the person it's talking to rather than fully overlapping them
      // — which also keeps the relationship line (drawn below) visibly non-zero.
      if (a.status === "moving") view.phase = Math.min(0.82, view.phase + 0.012 * dt);
      else view.phase = 0;
      const gp = agentGridPosition(a, this.layout, this.world, view.phase);
      const sp = toScreen(gp.col, gp.row);
      view.container.position.set(sp.x, sp.y);
      // Z-order by screen-y so nearer characters draw on top.
      view.container.zIndex = sp.y;
    }
    this.agentLayer.sortableChildren = true;

    // Draw active edges as glowing relationship lines. Endpoints are the two
    // agents' HOME desks (not the live, animating positions) so the line is always
    // full-length and stable while the edge is active — the moving leader token
    // rides along it. Lines are lifted to head height and drawn thick + bright so
    // "who's talking to whom" reads at a glance, even for short intra-room edges.
    // Vertical (leader→report) is amber; lateral (peer↔peer) is blue.
    const HEAD = 34; // px above the character's feet anchor
    const t = (this.app.ticker.lastTime / 700) % 1;
    for (const e of this.world.edges) {
      if (!e.active) continue;
      const fromDesk = this.layout.deskOf.get(e.from);
      const toDesk = this.layout.deskOf.get(e.to);
      if (!fromDesk || !toDesk) continue;
      const from = toScreen(fromDesk.col, fromDesk.row);
      const to = toScreen(toDesk.col, toDesk.row);
      const col = e.kind === "vertical" ? 0xfbbf24 : 0x60a5fa;
      const fx = from.x;
      const fy = from.y - HEAD;
      const tx = to.x;
      const ty = to.y - HEAD;
      // Soft glow underlay + crisp core line.
      this.edgeGfx.moveTo(fx, fy).lineTo(tx, ty).stroke({ width: 6, color: col, alpha: 0.18 });
      this.edgeGfx.moveTo(fx, fy).lineTo(tx, ty).stroke({ width: 2, color: col, alpha: 0.9 });
      // A traveling pulse dot showing message flow direction (from → to).
      const px = fx + (tx - fx) * t;
      const py = fy + (ty - fy) * t;
      this.edgeGfx.circle(px, py, 4).fill({ color: col, alpha: 1 });
    }
  }

  // ── Camera + input ─────────────────────────────────────────────────────
  private centerCameraOnScreen(): void {
    this.camera.scale.set(1);
    this.camera.position.set(this.app.renderer.width / 2, this.app.renderer.height / 2);
  }

  private fitOfficeToView(): void {
    if (!this.layout) {
      this.centerCameraOnScreen();
      return;
    }
    const b = this.layout.bounds;
    const tl = toScreen(b.minCol, b.maxRow); // leftmost x
    const tr = toScreen(b.maxCol, b.minRow); // rightmost x
    const top = toScreen(b.minCol, b.minRow);
    const bot = toScreen(b.maxCol, b.maxRow);
    const w = Math.max(tr.x - tl.x, 1);
    const h = Math.max(bot.y - top.y, 1);
    const vw = this.app.renderer.width;
    const vh = this.app.renderer.height;
    const scale = Math.min(vw / (w + 200), vh / (h + 200), 1.4);
    this.camera.scale.set(scale);
    const cx = (tl.x + tr.x) / 2;
    const cy = (top.y + bot.y) / 2;
    this.camera.position.set(vw / 2 - cx * scale, vh / 2 - cy * scale);
  }

  private onKeyDown = (e: KeyboardEvent) => this.keys.add(e.key.toLowerCase());
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());

  private installInput(): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);

    const canvas = this.app.canvas;
    canvas.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.lastPointer = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener("pointerup", () => (this.dragging = false));
    window.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.camera.position.x += dx;
      this.camera.position.y += dy;
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        // Zoom around the cursor: keep the world point under the pointer fixed.
        const wx = (px - this.camera.position.x) / this.camera.scale.x;
        const wy = (py - this.camera.position.y) / this.camera.scale.y;
        const next = Math.min(Math.max(this.camera.scale.x * factor, 0.25), 3);
        this.camera.scale.set(next);
        this.camera.position.x = px - wx * next;
        this.camera.position.y = py - wy * next;
      },
      { passive: false },
    );
  }
}
