#!/usr/bin/env node
/**
 * gen-jobs-registry — enumerate this machine's launchd automations (the
 * "Scheduled Jobs" dashboard's data source) and print them as a JSON array.
 *
 * Plain words: `launchctl list` tells you WHAT is loaded, but not what it does,
 * when it last ran, or when it runs next. This script cross-references three
 * sources to answer that:
 *
 *   1. `launchctl list`            — which jobs are loaded + their current pid/exit code
 *   2. each job's .plist file      — its schedule (StartInterval / StartCalendarInterval),
 *                                    its command, and where it logs to
 *   3. `launchctl print gui/<uid>/<label>` — richer runtime state (last exit code)
 *   4. jobs-registry.json (the "seed") — the human purpose/owner, since launchd
 *                                    has no concept of "what is this job FOR"
 *
 * Self-contained: no npm deps, only Node built-ins + the `launchctl`/`plutil`
 * CLIs that ship with macOS. All target jobs run as the logged-in user
 * (gui/<uid>), so nothing here needs sudo.
 *
 * Usage: gen-jobs-registry [--seed <path>]
 * Output: a JSON array of AutomationJob records on stdout.
 */
import { execFileSync } from "node:child_process";
import { statSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";

/** Only these launchd label prefixes are "ours" — everything else (Apple's
 * own daemons, other apps) is noise for this dashboard. */
const LABEL_PREFIXES = [
  "ai.6thsense.",
  "com.ronak.",
  "dev.6thsense.",
  "dev.ronak.",
  "ai.openclaw.",
];

/** Default seed path: the shared purpose/owner registry checked into the
 * 6thSense ops folder. Overridable via --seed for tests/other machines. */
const DEFAULT_SEED_PATH = path.join(
  homedir(),
  "Documents",
  "00-6thsense",
  "ops",
  "jobs-registry.json",
);

function parseArgs(argv) {
  const out = { seed: DEFAULT_SEED_PATH };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seed" && argv[i + 1]) {
      out.seed = argv[++i];
    }
  }
  return out;
}

/** Load the seed registry. Missing/malformed file degrades to `{}` — a
 * dashboard with undocumented purposes beats a dashboard that crashes. */
function loadSeed(seedPath) {
  try {
    return JSON.parse(readFileSync(seedPath, "utf8"));
  } catch {
    return {};
  }
}

/** Run a command and return trimmed stdout, or null on any failure (missing
 * binary, non-zero exit, timeout). Best-effort by design — this dashboard
 * must degrade gracefully rather than crash the enumeration. */
function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      // A missing plist key (e.g. no StartInterval on a calendar-scheduled
      // job) is an expected, silent miss — plutil's stderr complaint about it
      // is noise, not a diagnostic, so we drop it rather than leak it onto
      // the caller's terminal/logs.
      stdio: ["ignore", "pipe", "ignore"],
      ...opts,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Parse `launchctl list` output into a map of label -> { pid, exitStatus }.
 * Format: `PID\tStatus\tLabel`, tab-separated, header row first. `pid` is a
 * number when running, or null when not running (launchctl prints "-").
 * `exitStatus` is the last exit code launchd recorded (0 = clean).
 */
function parseLaunchctlList(raw) {
  const map = new Map();
  if (!raw) return map;
  const lines = raw.split("\n").slice(1); // drop header
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [pidRaw, statusRaw, label] = parts;
    if (!label) continue;
    const pid = pidRaw === "-" ? null : Number(pidRaw);
    const exitStatus = Number.isFinite(Number(statusRaw)) ? Number(statusRaw) : null;
    map.set(label.trim(), { pid: Number.isFinite(pid) ? pid : null, exitStatus });
  }
  return map;
}

/** True if a label matches one of the prefixes we care about. */
function isOurs(label) {
  return LABEL_PREFIXES.some((p) => label.startsWith(p));
}

/**
 * Find the .plist backing a label. Convention-first: `<LaunchAgents>/<label>.plist`
 * covers the overwhelming majority of jobs. Falls back to scanning every plist
 * in the LaunchAgents dir and matching on its declared Label (covers jobs
 * installed under a different filename), then does the same for the system
 * LaunchDaemons dir as a last resort (still gui/<uid>-scoped jobs can, in
 * practice, occasionally live there). Returns null if nothing matches.
 */
function findPlistPath(label) {
  const dirs = [
    path.join(homedir(), "Library", "LaunchAgents"),
    "/Library/LaunchAgents",
  ];
  for (const dir of dirs) {
    const direct = path.join(dir, `${label}.plist`);
    if (existsSync(direct)) return direct;
  }
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".plist"));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const declaredLabel = run("plutil", ["-extract", "Label", "raw", "-o", "-", full]);
      if (declaredLabel === label) return full;
    }
  }
  return null;
}

/** Extract one key from a plist as raw text, or null if absent/unparsable. */
function extractRaw(plistPath, key) {
  return run("plutil", ["-extract", key, "raw", "-o", "-", plistPath]);
}

/** Extract one key from a plist as JSON, or null if absent/unparsable. */
function extractJson(plistPath, key) {
  const raw = run("plutil", ["-extract", key, "json", "-o", "-", plistPath]);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Zero-pad a number to 2 digits ("HH:MM" formatting). */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Human schedule string from a job's plist. Handles the two launchd schedule
 * mechanisms:
 *   - StartInterval (seconds): "every Nh" / "every Nm" / "every Ns"
 *   - StartCalendarInterval (one dict, or an array for multiple fire times):
 *     "daily HH:MM" (no Weekday) or "Mon,Thu HH:MM" (Weekday present)
 * Returns null if neither is set (e.g. a job only triggered by
 * WatchPaths/RunAtLoad, which this dashboard doesn't attempt to summarize).
 */
function scheduleHuman(plistPath) {
  const intervalRaw = extractRaw(plistPath, "StartInterval");
  if (intervalRaw != null) {
    const seconds = Number(intervalRaw);
    if (Number.isFinite(seconds) && seconds > 0) {
      if (seconds % 3600 === 0) return `every ${seconds / 3600}h`;
      if (seconds % 60 === 0) return `every ${seconds / 60}m`;
      return `every ${seconds}s`;
    }
  }

  const cal = extractJson(plistPath, "StartCalendarInterval");
  if (cal != null) {
    const entries = Array.isArray(cal) ? cal : [cal];
    const times = entries
      .map((e) => {
        const hour = typeof e.Hour === "number" ? e.Hour : 0;
        const minute = typeof e.Minute === "number" ? e.Minute : 0;
        const weekday = typeof e.Weekday === "number" ? e.Weekday : null;
        return { hour, minute, weekday };
      })
      .filter((e) => e != null);
    if (times.length === 0) return null;

    const weekdaySet = new Set(times.map((t) => t.weekday).filter((w) => w != null));
    // All entries share one time-of-day in the common case; if they differ,
    // just show the earliest as the headline time (best-effort, not lossy —
    // next_run below still accounts for every entry).
    const first = times[0];
    const hhmm = `${pad2(first.hour)}:${pad2(first.minute)}`;

    if (weekdaySet.size === 0) return `daily ${hhmm}`;
    const names = [...weekdaySet]
      .map((w) => WEEKDAY_NAMES[((w % 7) + 7) % 7])
      .join(",");
    return `${names} ${hhmm}`;
  }

  return null;
}

/**
 * Next fire time for StartCalendarInterval entries: the earliest upcoming
 * Date across all entries (each entry may pin Weekday/Hour/Minute; Day/Month
 * are rare for these jobs and left unconstrained if absent).
 */
function nextCalendarRun(cal, now) {
  const entries = Array.isArray(cal) ? cal : [cal];
  let best = null;
  for (const e of entries) {
    const hour = typeof e.Hour === "number" ? e.Hour : 0;
    const minute = typeof e.Minute === "number" ? e.Minute : 0;
    const weekday = typeof e.Weekday === "number" ? ((e.Weekday % 7) + 7) % 7 : null;

    const candidate = new Date(now);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
    if (weekday != null) {
      // Advance to the next matching weekday (0-6 days forward).
      for (let i = 0; i < 7; i++) {
        if (candidate.getDay() === weekday) break;
        candidate.setDate(candidate.getDate() + 1);
      }
    }
    if (best == null || candidate.getTime() < best.getTime()) best = candidate;
  }
  return best;
}

/**
 * Best-effort last-run timestamp: the mtime of the job's stdout log file
 * (StandardOutPath) — a job that ran recently touched its own log. Falls
 * back to null (unknown) if there's no log path or the file doesn't exist
 * yet (e.g. never run since install).
 */
function lastRunFromLog(logPath) {
  if (!logPath) return null;
  try {
    return statSync(logPath).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * Query `launchctl print` for a label's live runtime state — the richest
 * source for "last exit code", but slower and occasionally unavailable
 * (e.g. the job was loaded but has never run). Best-effort: returns
 * `{ lastExitStatus: null }` on any failure.
 */
function runtimeInfo(label, uid) {
  const raw = run("launchctl", ["print", `gui/${uid}/${label}`]);
  if (!raw) return { lastExitStatus: null };
  const m = raw.match(/last exit code\s*=\s*(-?\d+)/);
  return { lastExitStatus: m ? Number(m[1]) : null };
}

function buildJob(label, listEntry, seed, host, uid) {
  const plistPath = findPlistPath(label);
  const purpose = seed[label]?.purpose ?? "(undocumented)";
  const owner = seed[label]?.owner ?? null;

  const programArgs = plistPath ? extractJson(plistPath, "ProgramArguments") : null;
  const program = Array.isArray(programArgs)
    ? programArgs.join(" ")
    : plistPath
      ? extractRaw(plistPath, "Program")
      : null;
  const logPath = plistPath ? extractRaw(plistPath, "StandardOutPath") : null;

  const schedule_human = plistPath ? scheduleHuman(plistPath) : null;
  const last_run = lastRunFromLog(logPath);

  const now = new Date();
  let next_run = null;
  if (plistPath) {
    const intervalRaw = extractRaw(plistPath, "StartInterval");
    const cal = extractJson(plistPath, "StartCalendarInterval");
    if (cal != null) {
      const next = nextCalendarRun(cal, now);
      next_run = next ? next.toISOString() : null;
    } else if (intervalRaw != null) {
      const seconds = Number(intervalRaw);
      if (Number.isFinite(seconds) && seconds > 0) {
        const base = last_run ? new Date(last_run) : now;
        next_run = new Date(base.getTime() + seconds * 1000).toISOString();
      }
    }
  }

  const { lastExitStatus } = runtimeInfo(label, uid);
  const isRunning = listEntry?.pid != null;
  const exitStatus = lastExitStatus ?? listEntry?.exitStatus ?? null;

  let status = "enabled";
  if (isRunning) status = "active";
  else if (exitStatus != null && exitStatus !== 0) status = "failed";

  return {
    id: label,
    host,
    schedule_human,
    next_run,
    last_run,
    last_exit_status: exitStatus,
    status,
    purpose,
    owner,
    log_path: logPath,
    program,
  };
}

function main() {
  const { seed: seedPath } = parseArgs(process.argv.slice(2));
  const seed = loadSeed(seedPath);
  const host = hostname();
  const uid = process.getuid ? process.getuid() : 501;

  const listRaw = run("launchctl", ["list"]);
  const listMap = parseLaunchctlList(listRaw);

  const labels = [...listMap.keys()].filter(isOurs);
  const jobs = labels.map((label) => buildJob(label, listMap.get(label), seed, host, uid));

  jobs.sort((a, b) => a.id.localeCompare(b.id));
  process.stdout.write(JSON.stringify(jobs, null, 2) + "\n");
}

main();
