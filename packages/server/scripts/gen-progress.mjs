#!/usr/bin/env node
/**
 * gen-progress — mine 6thSense "shipped work" progress into a single snapshot
 * JSON that the DevHub server serves at GET /api/progress.
 *
 * Plain words: over many autonomous Workflow runs, subagents already produced a
 * structured list of what they did — a stream of `result` lines carrying an
 * `items: [{date,project,type,title,summary,status,evidence,impact}]` array.
 * That is a ready-made changelog; nobody should re-derive it by hand or with an
 * LLM. This script:
 *
 *   1. Globs every workflow journal under the 00-6thsense Claude project
 *      (the `subagents/workflows/wf_<id>/journal.jsonl` files) so new runs are
 *      picked up automatically, flattens all `items`, dedupes on
 *      hash(project|date|title), and groups them by project -> feature -> item.
 *   2. Computes a CHEAP, no-LLM token/effort + session tally straight from the
 *      raw transcripts (Claude `~/.claude/projects` and Codex
 *      `~/.codex/archived_sessions` `.jsonl` files), bucketed by project / date /
 *      harness. This is the "effort" signal.
 *   3. Writes the merged snapshot to `${DEVHUB_DATA:-~/.claude-ui}/progress-snapshot.json`.
 *
 * HONESTY NOTE (load-bearing): transcripts are keyed by the Claude/Codex working
 * directory, NOT by these logical sub-projects, and all the 00-6thsense journals
 * live under ONE Claude project dir. So per-logical-project token totals are a
 * best-effort attribution (cwd path -> slug heuristic) and are always flagged
 * `approx: true`. The TRUSTWORTHY per-project effort signal is `itemCount`
 * (count of shipped/total work items). Never present the token figure as exact.
 *
 * Self-contained: no npm deps, only Node built-ins. Mirrors the structure of
 * `gen-jobs-registry.mjs` (Node ESM, emits/writes JSON, degrades gracefully).
 *
 * Usage:
 *   node gen-progress.mjs            # write snapshot to the DevHub data dir
 *   node gen-progress.mjs --stdout   # also print the snapshot to stdout
 *   node gen-progress.mjs --out <p>  # write to an explicit path
 *   node gen-progress.mjs --home <p> # override home (tests)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

/** Canonical logical project slugs (mirrors the reference report + the journal
 * `project` field). Anything unrecognized folds into "other". */
const CANONICAL_PROJECTS = [
  "capture",
  "nerve",
  "devhub",
  "company-platform",
  "cappa",
  "gbrain",
  "synapse",
  "landing",
  "robotics",
  "drive",
  "postprocess",
  "other",
];

/** Human display names for the slugs (fallback = the slug itself). */
const PROJECT_NAMES = {
  capture: "Capture",
  nerve: "Nerve SDK",
  devhub: "DevHub",
  "company-platform": "Company Platform",
  cappa: "Cappa",
  gbrain: "gbrain",
  synapse: "Synapse",
  landing: "Landing",
  robotics: "Robotics",
  drive: "Drive",
  postprocess: "Postprocess",
  other: "Other",
};

/**
 * Ordered cwd-path -> logical-slug rules for attributing raw transcript effort.
 * ORDER MATTERS: more specific tokens first (e.g. company-platform before a bare
 * "company"). Purely heuristic; see the honesty note at the top.
 */
const CWD_SLUG_RULES = [
  [/company[-_ ]?platform|company[-_ ]?final|hermes/i, "company-platform"],
  [/postprocess/i, "postprocess"],
  [/cappa/i, "cappa"],
  [/gbrain/i, "gbrain"],
  [/synapse/i, "synapse"],
  [/sensorium|\bcapture\b/i, "capture"],
  [/nerve/i, "nerve"],
  [/devhub|claude-ui/i, "devhub"],
  [/landing/i, "landing"],
  [/robotics/i, "robotics"],
  [/drive/i, "drive"],
];

function parseArgs(argv) {
  const out = { stdout: false, out: null, home: homedir() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--stdout") out.stdout = true;
    else if (argv[i] === "--out" && argv[i + 1]) out.out = argv[++i];
    else if (argv[i] === "--home" && argv[i + 1]) out.home = argv[++i];
  }
  return out;
}

/**
 * Where DevHub keeps its data — honors DEVHUB_DATA (preferred) / CLAUDE_UI_DATA
 * (legacy alias), else the legacy default `<home>/.claude-ui`. Replicated here
 * (not imported from the engine) so this stays a dependency-free standalone
 * script; kept in lockstep with `packages/engine/src/compat-identifiers.ts`.
 */
function appDataDir(home) {
  const explicit = process.env.DEVHUB_DATA?.trim() || process.env.CLAUDE_UI_DATA?.trim();
  if (explicit) return explicit;
  return path.join(home, ".claude-ui");
}

// ────────────────────────────────────────────────────────────────────────────
// Small utils
// ────────────────────────────────────────────────────────────────────────────

/** Stable dedupe/id hash from a work item's identity. */
function itemId(project, date, title) {
  return createHash("sha1").update(`${project}|${date}|${title}`).digest("hex").slice(0, 16);
}

/** Recursively collect files matching `pred` under `dir`. Best-effort — an
 * unreadable subdir is skipped, never fatal. */
function walk(dir, pred, acc = [], depth = 0) {
  if (depth > 12) return acc;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, pred, acc, depth + 1);
    else if (pred(full)) acc.push(full);
  }
  return acc;
}

/** Map a real cwd string to a canonical logical slug (heuristic). */
function slugForCwd(cwd) {
  if (!cwd) return "other";
  for (const [re, slug] of CWD_SLUG_RULES) {
    if (re.test(cwd)) return slug;
  }
  return "other";
}

/** Known aliases -> canonical slug (checked after slash-splitting). */
const PROJECT_ALIASES = {
  sensorium: "capture", // capture repo was renamed sensorium
  "capture-companion": "capture",
  "nerve-sdk": "nerve",
  "claude-ui": "devhub",
  ui: "devhub",
  company: "company-platform",
  platform: "company-platform",
  "robotics-hand": "robotics",
};

/**
 * Normalize a work item's `project` field onto a canonical slug. Handles the
 * real shapes seen in the journals: bare slugs, aliases ("sensorium"), and
 * compound "a/b" values ("capture/sensorium", "synapse/capture-companion") —
 * for those the FIRST segment wins. Falls back to a canonical-prefix match
 * ("robotics-hand" -> "robotics") before giving up to "other".
 */
function normalizeProject(raw) {
  if (!raw || typeof raw !== "string") return "other";
  const full = raw.trim().toLowerCase();
  const first = full.split("/")[0].trim();
  for (const cand of [first, full]) {
    if (CANONICAL_PROJECTS.includes(cand)) return cand;
    if (PROJECT_ALIASES[cand]) return PROJECT_ALIASES[cand];
  }
  for (const slug of CANONICAL_PROJECTS) {
    if (slug !== "other" && (first === slug || first.startsWith(`${slug}-`))) return slug;
  }
  return "other";
}

/**
 * Derive a feature/epic key for grouping a project's items. Heuristic:
 *   - a milestone tag (M3..M8) becomes its own bucket ("M8")
 *   - an ALL-CAPS epic tag prefix ("REPO-REHAUL: ...") becomes that tag
 *   - otherwise the first two meaningful words of the title
 * Not meant to be perfect; the design accepts degrading to coarse buckets.
 */
function featureKeyFor(title) {
  const t = (title || "").trim();
  const milestone = t.match(/\bM(\d{1,2})\b/);
  if (milestone) return `m${milestone[1]}`;
  // Leading "TAG:" or "Tag -" style epic prefix.
  const tag = t.match(/^([A-Za-z][\w-]{2,})\s*[:\-—]/);
  if (tag) return tag[1].toLowerCase();
  const words = t
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const key = words.slice(0, 2).join("-");
  return key || "general";
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "add", "added", "new", "fix", "fixed",
  "update", "updated", "make", "made", "into", "from", "that", "this",
]);

/** Title-case a feature key for display. */
function featureTitle(key, sampleTitle) {
  if (/^m\d+$/.test(key)) return `Milestone ${key.slice(1)}`;
  if (sampleTitle) return sampleTitle;
  return key.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Empty per-status counter that also accumulates arbitrary status strings. */
function bumpCount(map, key) {
  map[key] = (map[key] || 0) + 1;
}

// ────────────────────────────────────────────────────────────────────────────
// (1) Work items from workflow journals
// ────────────────────────────────────────────────────────────────────────────

/**
 * Glob every workflow journal under the 00-6thsense Claude project. The two
 * seed journals named in the design are just the ones that exist today; globbing
 * every `wf_<id>` workflow dir means new Workflow runs are mined automatically.
 */
function findJournals(home) {
  const projRoot = path.join(
    home,
    ".claude",
    "projects",
    "-Users-ronak-Documents-00-6thsense",
  );
  if (!existsSync(projRoot)) return [];
  return walk(
    projRoot,
    (f) => f.endsWith("journal.jsonl") && f.includes(`${path.sep}workflows${path.sep}`),
  );
}

/** Parse one journal, returning its `items` with provenance attached. */
function itemsFromJournal(file) {
  const workflowId = (file.match(/wf_[^/\\]+/) || ["unknown"])[0];
  const journal = path.basename(path.dirname(file)) + "/journal.jsonl";
  const out = [];
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    if (!line || line.indexOf('"items"') === -1) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const items = o?.result?.items;
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      out.push({ raw: it, source: { workflowId, journal } });
    }
  }
  return out;
}

/** Build the deduped, project->feature-grouped project list from all journals. */
function buildProjects(home) {
  const journals = findJournals(home);
  const seen = new Set();
  // slug -> { items: [], statusCounts, typeCounts, dates:Set }
  const byProject = new Map();
  let total = 0;

  for (const file of journals) {
    for (const { raw, source } of itemsFromJournal(file)) {
      const project = normalizeProject(raw.project);
      const date = typeof raw.date === "string" ? raw.date.slice(0, 10) : "";
      const title = typeof raw.title === "string" ? raw.title : "(untitled)";
      const id = itemId(project, date, title);
      if (seen.has(id)) continue;
      seen.add(id);
      total++;

      const item = {
        id,
        date,
        project,
        type: typeof raw.type === "string" ? raw.type : "other",
        title,
        summary: typeof raw.summary === "string" ? raw.summary : "",
        status: typeof raw.status === "string" ? raw.status : "shipped",
        evidence: typeof raw.evidence === "string" && raw.evidence ? raw.evidence : null,
        impact: typeof raw.impact === "string" && raw.impact ? raw.impact : null,
        source,
      };

      if (!byProject.has(project)) byProject.set(project, []);
      byProject.get(project).push(item);
    }
  }

  const projects = [];
  for (const [slug, items] of byProject) {
    items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first
    const statusCounts = {};
    const typeCounts = {};
    const dates = [];
    // feature bucketing
    const featMap = new Map();
    for (const it of items) {
      bumpCount(statusCounts, it.status);
      bumpCount(typeCounts, it.type);
      if (it.date) dates.push(it.date);
      const fk = featureKeyFor(it.title);
      if (!featMap.has(fk)) featMap.set(fk, []);
      featMap.get(fk).push(it);
    }
    const features = [];
    for (const [key, fitems] of featMap) {
      const fstatus = {};
      const fdates = [];
      for (const it of fitems) {
        bumpCount(fstatus, it.status);
        if (it.date) fdates.push(it.date);
      }
      fdates.sort();
      features.push({
        key,
        title: featureTitle(key, fitems.length === 1 ? fitems[0].title : null),
        itemCount: fitems.length,
        statusCounts: fstatus,
        firstDate: fdates[0] || "",
        lastDate: fdates[fdates.length - 1] || "",
        items: fitems, // already newest-first
      });
    }
    features.sort((a, b) => b.itemCount - a.itemCount || (a.lastDate < b.lastDate ? 1 : -1));
    dates.sort();

    projects.push({
      slug,
      name: PROJECT_NAMES[slug] || slug,
      itemCount: items.length,
      statusCounts,
      typeCounts,
      firstDate: dates[0] || "",
      lastDate: dates[dates.length - 1] || "",
      features,
      effort: { tokens: null, approx: true, itemCount: items.length },
    });
  }

  projects.sort((a, b) => b.itemCount - a.itemCount);
  return { projects, total, journalCount: journals.length };
}

// ────────────────────────────────────────────────────────────────────────────
// (2) Cheap transcript-derived token/effort + session tally
// ────────────────────────────────────────────────────────────────────────────

function emptyHarness() {
  return { tokens: 0, sessions: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0 };
}

/** Sum Claude transcript usage across all 6thSense project folders. */
function claudeEffort(home, acc) {
  const root = path.join(home, ".claude", "projects");
  let folders = [];
  try {
    folders = readdirSync(root).filter((f) => /6thsense/i.test(f));
  } catch {
    return;
  }
  for (const folder of folders) {
    const dir = path.join(root, folder);
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      let raw;
      try {
        raw = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      let sessionTokens = 0;
      let sessionSlug = "other";
      let sessionDate = "";
      let sawUsage = false;
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.cwd && sessionSlug === "other") sessionSlug = slugForCwd(o.cwd);
        if (!sessionDate && typeof o.timestamp === "string") sessionDate = o.timestamp.slice(0, 10);
        const u = o?.message?.usage;
        if (!u) continue;
        sawUsage = true;
        const inp = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        const out = u.output_tokens || 0;
        const cache = (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        sessionTokens += inp + out;
        acc.byHarness.claude.inputTokens += inp;
        acc.byHarness.claude.outputTokens += out;
        acc.byHarness.claude.cacheTokens += cache;
      }
      if (!sawUsage) continue;
      const slug = sessionSlug;
      acc.byHarness.claude.tokens += sessionTokens;
      acc.byHarness.claude.sessions += 1;
      acc.totalTokens += sessionTokens;
      addProject(acc, slug, sessionTokens);
      addDate(acc, sessionDate, sessionTokens);
    }
  }
}

/** Sum Codex archived-session token usage. Codex writes a cumulative
 * `total_token_usage.total_tokens` per turn, so we take the max per session to
 * avoid double counting. */
function codexEffort(home, acc) {
  const root = path.join(home, ".codex", "archived_sessions");
  if (!existsSync(root)) return;
  const files = walk(root, (f) => f.endsWith(".jsonl"));
  for (const full of files) {
    let raw;
    try {
      raw = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    let cwd = "";
    let date = "";
    let cumulative = 0;
    let sawUsage = false;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const p = o.payload || o;
      if (p.type === "session_meta") {
        cwd = p.payload?.cwd || p.cwd || cwd;
        date = (p.payload?.timestamp || o.timestamp || "").slice(0, 10) || date;
      }
      if (!cwd && p.cwd) cwd = p.cwd;
      if (!date && typeof o.timestamp === "string") date = o.timestamp.slice(0, 10);
      const info = p.payload?.info || p.info;
      const tot = info?.total_token_usage?.total_tokens;
      if (typeof tot === "number") {
        sawUsage = true;
        if (tot > cumulative) cumulative = tot; // cumulative -> keep the max
      }
    }
    // Only attribute Codex sessions that actually ran in a 6thSense workspace.
    const slug = slugForCwd(cwd);
    const inScope = /6thsense/i.test(cwd) || slug !== "other";
    if (!sawUsage || !inScope) continue;
    acc.byHarness.codex.tokens += cumulative;
    acc.byHarness.codex.sessions += 1;
    acc.byHarness.codex.outputTokens += cumulative; // codex info is aggregate-only
    acc.totalTokens += cumulative;
    addProject(acc, slug, cumulative);
    addDate(acc, date, cumulative);
    acc.generatedFrom.codexSessions += 1;
  }
}

function addProject(acc, slug, tokens) {
  if (!acc.byProject[slug]) acc.byProject[slug] = { tokens: 0, sessions: 0 };
  acc.byProject[slug].tokens += tokens;
  acc.byProject[slug].sessions += 1;
}

function addDate(acc, date, tokens) {
  if (!date) return;
  if (!acc._dateMap[date]) acc._dateMap[date] = { date, tokens: 0, sessions: 0 };
  acc._dateMap[date].tokens += tokens;
  acc._dateMap[date].sessions += 1;
}

function buildEffort(home) {
  const acc = {
    approx: true,
    source: "transcripts",
    totalTokens: 0,
    byHarness: { claude: emptyHarness(), codex: emptyHarness() },
    byProject: {},
    byDate: [],
    generatedFrom: { claudeSessions: 0, codexSessions: 0 },
    _dateMap: {},
  };
  claudeEffort(home, acc);
  codexEffort(home, acc);
  acc.generatedFrom.claudeSessions = acc.byHarness.claude.sessions;
  acc.byDate = Object.values(acc._dateMap).sort((a, b) => (a.date < b.date ? -1 : 1));
  delete acc._dateMap;
  return acc;
}

// ────────────────────────────────────────────────────────────────────────────
// Assemble + write
// ────────────────────────────────────────────────────────────────────────────

function buildSnapshot(home) {
  const { projects, total } = buildProjects(home);
  const effort = buildEffort(home);

  // Fold best-effort per-project token attribution onto each project's effort.
  for (const p of projects) {
    const e = effort.byProject[p.slug];
    if (e) p.effort.tokens = e.tokens;
  }

  const statusCounts = {};
  let shipped = 0;
  let firstDate = "";
  let lastDate = "";
  for (const p of projects) {
    for (const [k, v] of Object.entries(p.statusCounts)) {
      statusCounts[k] = (statusCounts[k] || 0) + v;
    }
    shipped += p.statusCounts.shipped || 0;
    if (p.firstDate && (!firstDate || p.firstDate < firstDate)) firstDate = p.firstDate;
    if (p.lastDate && p.lastDate > lastDate) lastDate = p.lastDate;
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    window: { since: firstDate || null, until: lastDate || null },
    totals: {
      items: total,
      projects: projects.length,
      shipped,
      statusCounts,
    },
    projects,
    effort,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = buildSnapshot(args.home);
  const json = JSON.stringify(snapshot, null, 2);

  const outPath = args.out || path.join(appDataDir(args.home), "progress-snapshot.json");
  try {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, json + "\n");
    // A short human breadcrumb on stderr (stdout is reserved for --stdout JSON).
    process.stderr.write(
      `[gen-progress] wrote ${snapshot.totals.items} items across ` +
        `${snapshot.totals.projects} projects to ${outPath}\n`,
    );
  } catch (err) {
    process.stderr.write(`[gen-progress] FAILED to write ${outPath}: ${err?.message || err}\n`);
    process.exitCode = 1;
  }

  if (args.stdout) process.stdout.write(json + "\n");
}

main();
