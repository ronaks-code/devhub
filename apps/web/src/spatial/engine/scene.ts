/**
 * SpatialScene — the PixiJS renderer. It owns a WebGL canvas and turns a
 * `WorldState` into a living 2.5D isometric office you can pan/zoom around, plus
 * an aerial "hub" you travel before entering the OpenClaw building.
 *
 * Design choices that keep it light on the M5:
 * - One WebGL context, containers reused across ticks (reconcile, don't rebuild).
 * - Positions are SMOOTHED every frame toward each agent's current desk, so when
 *   an agent is pulled from its department room into a project room (a membership
 *   change), the character visibly WALKS there — no physics engine, just a lerp.
 * - Two "modes" share one camera: `hub` (aerial, you drive an avatar to the
 *   building) and `office` (the iso room scene). Entering zooms between them.
 *
 * Two ROOM TYPES are drawn distinctly: department rooms get a solid, dept-colored
 * border + cool floor; project rooms get a dashed amber border + warm floor + a
 * "PROJECT" tag. Every character and every room wears a floating, Warzone-style
 * NAMEPLATE showing who/what it is and its current work.
 *
 * This file is the only place that touches Pixi; math lives in `iso.ts`.
 */

import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { departmentLabel, type Agent, type Room, type WorldState } from "../contract";
import {
  TILE_W,
  TILE_H,
  agentGridPosition,
  computeLayout,
  deptColor,
  projectAccent,
  screenBounds,
  toScreen,
  type RoomLayout,
  type WorldLayout,
} from "./iso";

export type SceneMode = "hub" | "office";

interface AgentView {
  container: Container;
  body: Graphics;
  /** Warzone-style floating nameplate: a pill bg + name/work text above the head. */
  plate: Container;
  plateBg: Graphics;
  plateName: Text;
  plateTask: Text;
  statusDot: Graphics;
  /** Smoothed screen position (so a re-homed agent walks rather than teleports). */
  cur: { x: number; y: number };
  placed: boolean;
  lastPlate: string;
}

interface RoomView {
  container: Container;
  floor: Graphics;
  /** Floating banner above the room (dept label, or project name + status). */
  banner: Container;
  bannerBg: Graphics;
  bannerText: Text;
  lastBanner: string;
}

const nameStyle = (size: number, color = 0xf1f5f9) =>
  new TextStyle({ fontFamily: "ui-sans-serif, system-ui, sans-serif", fontSize: size, fill: color, fontWeight: "700" });
const subStyle = (size: number, color = 0x9ca3af) =>
  new TextStyle({ fontFamily: "ui-sans-serif, system-ui, sans-serif", fontSize: size, fill: color, fontWeight: "500" });

/** Trailing token of a codename, e.g. `vulcan-3` → "vulcan-3" stays; used raw. */
function agentDisplayName(agent: Agent): string {
  return agent.name;
}

/** One short line of "current work" for the floating nameplate. */
function agentWorkLine(agent: Agent): string {
  switch (agent.status) {
    case "working":
      return agent.assignment ? truncate(agent.assignment, 26) : "working";
    case "talking":
      return "talking";
    case "moving":
      return "on the move";
    case "blocked":
      return "blocked";
    case "done":
      return "wrapping up";
    default:
      return agent.project ? "on " + truncate(agent.project, 20) : "idle at desk";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
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
  /**
   * Whether the user has taken manual camera control (panned/zoomed). Until they
   * do, the office view AUTO-FITS to content on every layout change — so as the
   * mock feed spawns project rooms the camera keeps them framed instead of
   * leaving the dead space the one-shot fit produced. Reset on entering office.
   */
  private userAdjusted = false;

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
    // Keep the office framed as rooms spawn/despawn — until the user takes over.
    if (this.mode === "office" && !this.userAdjusted) this.fitOfficeToView();
  }

  setMode(mode: SceneMode): void {
    this.mode = mode;
    this.hubLayer.visible = mode === "hub";
    this.floorLayer.visible = mode === "office";
    this.roomLayer.visible = mode === "office";
    this.edgeLayer.visible = mode === "office";
    this.agentLayer.visible = mode === "office";
    if (mode === "office") {
      // Re-hand camera control to auto-fit each time we (re)enter the office.
      this.userAdjusted = false;
      this.fitOfficeToView();
    } else {
      this.centerCameraOnScreen();
    }
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
    const bl = new Text({ text: "OpenClaw HQ", style: nameStyle(16, 0x93c5fd) });
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
    const you = new Text({ text: "you", style: subStyle(11, 0xfca5a5) });
    you.anchor.set(0.5);
    you.position.set(0, 20);
    this.avatar.addChild(you);
    this.avatar.position.set(this.avatarPos.x, this.avatarPos.y);
    this.hubLayer.addChild(this.avatar);

    this.enterHint = new Text({ text: "▲ walk to OpenClaw HQ and press E to enter", style: subStyle(13, 0x9ca3af) });
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
        const banner = new Container();
        const bannerBg = new Graphics();
        const bannerText = new Text({ text: "", style: nameStyle(13) });
        bannerText.anchor.set(0.5, 0.5);
        banner.addChild(bannerBg, bannerText);
        c.addChild(floor, banner);
        this.roomLayer.addChild(c);
        view = { container: c, floor, banner, bannerBg, bannerText, lastBanner: "" };
        this.roomViews.set(id, view);
      }
      this.drawRoomFloor(view, rl.room, rl);
      this.drawRoomBanner(view, rl.room, rl);
    }
    for (const [id, view] of this.roomViews) {
      if (!seen.has(id)) {
        view.container.destroy({ children: true });
        this.roomViews.delete(id);
      }
    }
  }

  /** Paint a room's iso floor + border, styled by room TYPE. */
  private drawRoomFloor(view: RoomView, room: Room, rl: RoomLayout): void {
    const g = view.floor;
    g.clear();
    const isProject = room.kind === "project";
    const accent = isProject ? projectAccent() : deptColor(room.dept);
    // Floor tint: cool slate for departments, warm sepia for projects.
    const shadeA = isProject ? 0x201a12 : 0x17171c;
    const shadeB = isProject ? 0x1a150f : 0x131317;
    for (let dc = 0; dc < rl.cols; dc++) {
      for (let dr = 0; dr < rl.rows; dr++) {
        const p = toScreen(rl.origin.col + dc, rl.origin.row + dr);
        const shade = (dc + dr) % 2 === 0 ? shadeA : shadeB;
        g.poly([p.x, p.y, p.x + TILE_W / 2, p.y + TILE_H / 2, p.x, p.y + TILE_H, p.x - TILE_W / 2, p.y + TILE_H / 2]).fill(shade);
      }
    }
    // Border around the footprint. Department = solid; project = dashed amber.
    const o = toScreen(rl.origin.col, rl.origin.row);
    const tr = toScreen(rl.origin.col + rl.cols, rl.origin.row);
    const bl = toScreen(rl.origin.col, rl.origin.row + rl.rows);
    const br = toScreen(rl.origin.col + rl.cols, rl.origin.row + rl.rows);
    const ring = [o, tr, br, bl];
    if (isProject) {
      this.strokeDashed(g, ring, accent);
    } else {
      g.poly([o.x, o.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]).stroke({ width: 2, color: accent, alpha: 0.75 });
    }
  }

  /** Draw a dashed polygon outline (for project-room borders). */
  private strokeDashed(g: Graphics, pts: { x: number; y: number }[], color: number): void {
    const dash = 10;
    const gap = 7;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      let d = 0;
      while (d < len) {
        const s = d;
        const e = Math.min(d + dash, len);
        g.moveTo(a.x + ux * s, a.y + uy * s).lineTo(a.x + ux * e, a.y + uy * e);
        d += dash + gap;
      }
    }
    g.stroke({ width: 2.5, color, alpha: 0.95 });
  }

  /** Floating room nameplate: dept label, or project name + status + headcount. */
  private drawRoomBanner(view: RoomView, room: Room, rl: RoomLayout): void {
    const count = room.members.length;
    const isProject = room.kind === "project";
    let text: string;
    if (isProject) {
      const status = room.status ? ` — ${room.status}` : "";
      text = `▸ PROJECT · ${room.project}\n${count} on it${status}`;
    } else {
      text = `${departmentLabel(room.dept)}\n${count} home`;
    }
    if (text !== view.lastBanner) {
      view.bannerText.text = text;
      view.bannerText.style = isProject ? nameStyle(13, 0xfde68a) : nameStyle(13, 0xe5e7eb);
      view.bannerText.style.align = "center";
      const w = view.bannerText.width + 20;
      const h = view.bannerText.height + 12;
      const bg = view.bannerBg;
      bg.clear();
      bg.roundRect(-w / 2, -h / 2, w, h, 7).fill({ color: 0x0b0b0d, alpha: 0.82 });
      bg.roundRect(-w / 2, -h / 2, w, h, 7).stroke({ width: 1.5, color: isProject ? projectAccent() : deptColor(room.dept), alpha: 0.9 });
      view.lastBanner = text;
    }
    // Sit the banner well above the room's top corner so it clears the floating
    // nameplates of the first row of characters.
    const c0 = toScreen(rl.center.col, rl.origin.row - 2.2);
    view.banner.position.set(c0.x, c0.y);
  }

  private reconcileAgents(): void {
    const present = new Map(this.world.agents.map((a) => [a.id, a]));
    for (const [id, agent] of present) {
      let view = this.agentViews.get(id);
      if (!view) {
        const c = new Container();
        const body = new Graphics();
        const statusDot = new Graphics();
        statusDot.position.set(0, -30);
        // Floating nameplate.
        const plate = new Container();
        const plateBg = new Graphics();
        const plateName = new Text({ text: "", style: nameStyle(10) });
        plateName.anchor.set(0.5, 0);
        const plateTask = new Text({ text: "", style: subStyle(9) });
        plateTask.anchor.set(0.5, 0);
        plate.addChild(plateBg, plateName, plateTask);
        c.addChild(body, statusDot, plate);
        c.eventMode = "static";
        c.cursor = "pointer";
        c.on("pointerover", () => this.cb.onSelectAgent?.(present.get(id) ?? null));
        this.agentLayer.addChild(c);
        view = {
          container: c,
          body,
          plate,
          plateBg,
          plateName,
          plateTask,
          statusDot,
          cur: { x: 0, y: 0 },
          placed: false,
          lastPlate: "",
        };
        this.agentViews.set(id, view);
      }
      this.drawAgentBody(view, agent);
      this.drawAgentPlate(view, agent);
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

  /** Build the floating name/work plate above a character (Warzone style). */
  private drawAgentPlate(view: AgentView, agent: Agent): void {
    const name = agentDisplayName(agent);
    const work = agentWorkLine(agent);
    const key = `${name}|${work}|${agent.dept}`;
    if (key === view.lastPlate) return;
    view.plateName.text = name;
    view.plateName.style = nameStyle(10, deptColor(agent.dept));
    view.plateTask.text = work;
    const w = Math.max(view.plateName.width, view.plateTask.width) + 12;
    const h = view.plateName.height + view.plateTask.height + 8;
    // Anchor plate above the character's head.
    const top = agent.role === "leader" ? -58 : -52;
    view.plateName.position.set(0, top + 4);
    view.plateTask.position.set(0, top + 4 + view.plateName.height);
    const bg = view.plateBg;
    bg.clear();
    bg.roundRect(-w / 2, top, w, h, 6).fill({ color: 0x0b0b0d, alpha: 0.8 });
    bg.roundRect(-w / 2, top, w, h, 6).stroke({ width: 1, color: deptColor(agent.dept), alpha: 0.55 });
    view.lastPlate = key;
  }

  // ── Per-frame ──────────────────────────────────────────────────────────
  private frame(): void {
    const dt = this.app.ticker.deltaTime;
    if (this.mode === "hub") {
      this.updateHub(dt);
      return;
    }
    if (!this.layout) return;

    // Smooth each agent toward its current desk. When an agent is re-homed into a
    // different room (membership change), its target desk jumps and the character
    // walks there over a few frames — that's the dept→project movement.
    for (const a of this.world.agents) {
      const view = this.agentViews.get(a.id);
      if (!view) continue;
      const gp = agentGridPosition(a, this.layout, this.world, a.status === "moving" ? 0.6 : 0);
      const target = toScreen(gp.col, gp.row);
      if (!view.placed) {
        view.cur.x = target.x;
        view.cur.y = target.y;
        view.placed = true;
      } else {
        const k = Math.min(1, 0.16 * dt);
        view.cur.x += (target.x - view.cur.x) * k;
        view.cur.y += (target.y - view.cur.y) * k;
      }
      view.container.position.set(view.cur.x, view.cur.y);
      // Z-order by screen-y so nearer characters draw on top.
      view.container.zIndex = view.cur.y;
    }
    this.agentLayer.sortableChildren = true;

    // Draw active edges as glowing relationship lines between the two agents'
    // CURRENT desks — this is how "who's talking to whom" reads, including
    // cross-room / cross-department lines. Vertical (leader→report) is amber;
    // lateral (peer↔peer) is blue. A pulse rides from → to.
    //
    // Visibility: these must read at the fit/default zoom (scale can be <1), so
    // we paint THREE layers — a wide soft halo, a mid glow, and a bright core —
    // and gently pulse the core alpha so the line looks alive rather than static.
    this.edgeGfx.clear();
    const HEAD = 34; // px above the character's feet anchor
    const t = (this.app.ticker.lastTime / 700) % 1;
    const breathe = 0.82 + 0.18 * Math.sin(this.app.ticker.lastTime / 320); // 0.64..1.0
    for (const e of this.world.edges) {
      if (!e.active) continue;
      const fromDesk = this.layout.deskOf.get(e.from);
      const toDesk = this.layout.deskOf.get(e.to);
      if (!fromDesk || !toDesk) continue;
      const from = toScreen(fromDesk.col, fromDesk.row);
      const to = toScreen(toDesk.col, toDesk.row);
      // Vertical (leader→report) amber; lateral (peer↔peer) cyan — both punchy.
      const col = e.kind === "vertical" ? 0xfcd34d : 0x38bdf8;
      const fx = from.x;
      const fy = from.y - HEAD;
      const tx = to.x;
      const ty = to.y - HEAD;
      // Layer 1: wide soft halo (reads even when zoomed out).
      this.edgeGfx.moveTo(fx, fy).lineTo(tx, ty).stroke({ width: 12, color: col, alpha: 0.12 });
      // Layer 2: mid glow.
      this.edgeGfx.moveTo(fx, fy).lineTo(tx, ty).stroke({ width: 6, color: col, alpha: 0.32 });
      // Layer 3: bright crisp core, gently breathing.
      this.edgeGfx.moveTo(fx, fy).lineTo(tx, ty).stroke({ width: 2.5, color: col, alpha: breathe });
      // Small anchor pips at both ends so the connection's endpoints are obvious.
      this.edgeGfx.circle(fx, fy, 3).fill({ color: col, alpha: 0.9 });
      this.edgeGfx.circle(tx, ty, 3).fill({ color: col, alpha: 0.9 });
      // A traveling pulse dot showing message flow direction (from → to), with a
      // faint halo so it stays legible against busy floors.
      const px = fx + (tx - fx) * t;
      const py = fy + (ty - fy) * t;
      this.edgeGfx.circle(px, py, 9).fill({ color: col, alpha: 0.2 });
      this.edgeGfx.circle(px, py, 5).fill({ color: 0xffffff, alpha: 0.95 });
      this.edgeGfx.circle(px, py, 3).fill({ color: col, alpha: 1 });
    }
  }

  // ── Camera + input ─────────────────────────────────────────────────────
  private centerCameraOnScreen(): void {
    this.camera.scale.set(1);
    this.camera.position.set(this.app.renderer.width / 2, this.app.renderer.height / 2);
  }

  private fitOfficeToView(): void {
    if (!this.layout || this.layout.rooms.size === 0) {
      this.centerCameraOnScreen();
      return;
    }
    // TRUE screen AABB of the drawn content (see iso.screenBounds). `headroom`
    // reserves room for the floating room banner (~2.2 grid-rows up ≈ 70px on
    // screen) so it isn't clipped at the top; `pad` is a uniform margin. Fitting
    // to this exact box removes the dead space the old phantom-corner fit left.
    const b = screenBounds(this.layout, { headroom: 72, pad: 48 });
    const w = Math.max(b.maxX - b.minX, 1);
    const h = Math.max(b.maxY - b.minY, 1);
    const vw = this.app.renderer.width;
    const vh = this.app.renderer.height;
    const scale = Math.min(vw / w, vh / h, 1.4);
    this.camera.scale.set(scale);
    // Center horizontally, but TOP-ANCHOR vertically: the office is wide-and-short,
    // so fitting to width leaves vertical slack — we push that slack to the BOTTOM
    // (content starts just under the top HUD) rather than centering it, which is
    // what left the big empty band up top. TOP_MARGIN clears the top badge/toggle.
    const TOP_MARGIN = 96;
    const cx = (b.minX + b.maxX) / 2;
    const scaledH = h * scale;
    // If content is shorter than the viewport, sit it just below the HUD; if it's
    // taller, still fit (top at margin, bottom may extend — but scale prevents that).
    const y = scaledH < vh - TOP_MARGIN ? TOP_MARGIN - b.minY * scale : (vh - scaledH) / 2 - b.minY * scale;
    this.camera.position.set(vw / 2 - cx * scale, y);
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
      if (dx !== 0 || dy !== 0) this.userAdjusted = true; // stop auto-fitting
      this.camera.position.x += dx;
      this.camera.position.y += dy;
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.userAdjusted = true; // manual zoom => stop auto-fitting
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
