/**
 * Ink (terminal) face. Proves the "one brain, many faces" design: it imports the
 * SAME @claude-ui/engine directly — no HTTP server — and reuses its index/parser.
 */
import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Engine } from "@claude-ui/engine";
import type { NormalizedMessage, ProjectSummary, SessionSummary } from "@claude-ui/engine/types";

type Mode = "projects" | "sessions" | "transcript";

const VISIBLE = 16; // list/transcript window height

function clampWindow(idx: number, len: number): number {
  // top index of a scrolling window that keeps idx visible
  if (idx < VISIBLE) return 0;
  return Math.min(idx - VISIBLE + 1, Math.max(0, len - VISIBLE));
}

function flattenMessage(m: NormalizedMessage): string[] {
  const lines: string[] = [];
  const label = m.role === "assistant" ? "Claude" : m.role === "user" ? "You" : m.role;
  const head = m.blocks
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "thinking") return "(thinking…)";
      if (b.type === "tool_use") return `⚙ ${b.name}`;
      if (b.type === "tool_result") return `↳ ${b.isError ? "error" : "result"}`;
      return "";
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
  lines.push(`${label}: ${head}`.slice(0, 1000));
  return lines;
}

export function App({ engine }: { engine: Engine }) {
  const { exit } = useApp();
  const [mode, setMode] = useState<Mode>("projects");
  const [projects] = useState<ProjectSummary[]>(() => engine.getProjects());
  const [pIdx, setPIdx] = useState(0);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sIdx, setSIdx] = useState(0);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [scroll, setScroll] = useState(0);
  const [loading, setLoading] = useState(false);

  useInput((input, key) => {
    if (input === "q") {
      exit();
      return;
    }
    if (mode === "projects") {
      if (key.downArrow || input === "j") setPIdx((i) => Math.min(i + 1, projects.length - 1));
      else if (key.upArrow || input === "k") setPIdx((i) => Math.max(i - 1, 0));
      else if (key.return) {
        const p = projects[pIdx];
        if (p) {
          setProject(p);
          setSessions(engine.getProjectSessions(p.id));
          setSIdx(0);
          setMode("sessions");
        }
      }
    } else if (mode === "sessions") {
      if (key.downArrow || input === "j") setSIdx((i) => Math.min(i + 1, sessions.length - 1));
      else if (key.upArrow || input === "k") setSIdx((i) => Math.max(i - 1, 0));
      else if (key.escape || input === "h") setMode("projects");
      else if (key.return) {
        const s = sessions[sIdx];
        if (s) {
          setSession(s);
          setLoading(true);
          setMode("transcript");
          setScroll(0);
          engine
            .getSessionMessages(s.sessionId)
            .then((page) => setLines((page?.messages ?? []).flatMap(flattenMessage)))
            .finally(() => setLoading(false));
        }
      }
    } else if (mode === "transcript") {
      if (key.downArrow || input === "j") setScroll((s) => Math.min(s + 1, Math.max(0, lines.length - VISIBLE)));
      else if (key.upArrow || input === "k") setScroll((s) => Math.max(0, s - 1));
      else if (input === " ") setScroll((s) => Math.min(s + VISIBLE, Math.max(0, lines.length - VISIBLE)));
      else if (key.escape || input === "h") setMode("sessions");
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color="#d97757" bold>
          ◆ Claude UI
        </Text>
        <Text color="gray"> — terminal face · {projects.length} projects</Text>
      </Box>

      {mode === "projects" && (
        <List
          title="Projects"
          items={projects.map((p) => `${p.name}  ${" ".repeat(Math.max(1, 22 - p.name.length))}${p.sessionCount} sessions`)}
          idx={pIdx}
        />
      )}

      {mode === "sessions" && (
        <List
          title={`Sessions · ${project?.name ?? ""}`}
          items={sessions.map((s) => `${s.title}`.slice(0, 60))}
          idx={sIdx}
          empty="No sessions"
        />
      )}

      {mode === "transcript" && (
        <Box flexDirection="column">
          <Text color="cyan" bold>
            {session?.title}
          </Text>
          <Text color="gray">{session?.cwd ?? ""}</Text>
          <Box flexDirection="column" marginTop={1}>
            {loading ? (
              <Text color="gray">loading…</Text>
            ) : (
              lines.slice(scroll, scroll + VISIBLE).map((l, i) => (
                <Text key={scroll + i} wrap="truncate-end">
                  {l}
                </Text>
              ))
            )}
          </Box>
          <Text color="gray">
            {"\n"}
            {lines.length ? `${scroll + 1}-${Math.min(scroll + VISIBLE, lines.length)} / ${lines.length}` : ""}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          {mode === "projects"
            ? "↑↓/jk move · ⏎ open · q quit"
            : mode === "sessions"
              ? "↑↓/jk move · ⏎ open · esc/h back · q quit"
              : "↑↓/jk scroll · space page · esc/h back · q quit"}
        </Text>
      </Box>
    </Box>
  );
}

function List({
  title,
  items,
  idx,
  empty,
}: {
  title: string;
  items: string[];
  idx: number;
  empty?: string;
}) {
  const top = clampWindow(idx, items.length);
  const window = items.slice(top, top + VISIBLE);
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        {title}
      </Text>
      {items.length === 0 ? (
        <Text color="gray">{empty ?? "—"}</Text>
      ) : (
        window.map((it, i) => {
          const realIdx = top + i;
          const active = realIdx === idx;
          return (
            <Text key={realIdx} color={active ? "#d97757" : undefined} inverse={active}>
              {active ? "› " : "  "}
              {it}
            </Text>
          );
        })
      )}
    </Box>
  );
}
