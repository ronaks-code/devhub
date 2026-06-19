/**
 * Ink (terminal) face. Proves the "one brain, many faces" design: it imports the
 * SAME @devhub/engine directly — no HTTP server — and reuses its index/parser.
 */
import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Engine } from "@devhub/engine";
import type { ProjectSummary, SearchHit, SessionSummary } from "@devhub/engine/types";
import { Chat } from "./screens/Chat.js";
import { Search } from "./screens/Search.js";
import { Dashboard } from "./screens/Dashboard.js";
import { Transcript, flattenMessages, type Row } from "./components/Transcript.js";

type Mode = "projects" | "sessions" | "transcript" | "chat" | "search" | "dashboard";

/** Just the bits the transcript header renders — works for a SessionSummary or a SearchHit. */
type TranscriptHead = { sessionId: string; title: string; cwd: string | null };

const VISIBLE = 16; // list/transcript window height

function clampWindow(idx: number, len: number): number {
  // top index of a scrolling window that keeps idx visible
  if (idx < VISIBLE) return 0;
  return Math.min(idx - VISIBLE + 1, Math.max(0, len - VISIBLE));
}

export function App({ engine }: { engine: Engine }) {
  const { exit } = useApp();
  const [mode, setMode] = useState<Mode>("projects");
  const [projects] = useState<ProjectSummary[]>(() => engine.getProjects());
  const [pIdx, setPIdx] = useState(0);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sIdx, setSIdx] = useState(0);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  // Header bits for the open transcript (from a SessionSummary or a SearchHit).
  const [head, setHead] = useState<TranscriptHead | null>(null);
  // Rich transcript flattened to styled rows (see components/Transcript.tsx). The
  // app windows over these with the same VISIBLE/scroll math the list views use.
  const [rows, setRows] = useState<Row[]>([]);
  const [scroll, setScroll] = useState(0);
  const [loading, setLoading] = useState(false);
  // Which browse screen the chat screen returns to on Esc (set when launched).
  const [chatReturn, setChatReturn] = useState<"projects" | "sessions">("projects");
  // Which screen the transcript returns to on Esc (sessions list, or search results).
  const [transcriptReturn, setTranscriptReturn] = useState<"sessions" | "search">("sessions");

  // Open a session's transcript from anywhere (sessions list or search). Loads the
  // mirrored messages in-process and flips to the transcript view; `from` is where
  // Esc returns to.
  const openTranscript = (h: TranscriptHead, from: "sessions" | "search") => {
    setHead(h);
    setTranscriptReturn(from);
    setLoading(true);
    setMode("transcript");
    setScroll(0);
    engine
      .getSessionMessages(h.sessionId)
      .then((page) => setRows(flattenMessages(page?.messages ?? [])))
      .finally(() => setLoading(false));
  };

  useInput(
    (input, key) => {
      if (input === "q") {
        exit();
        return;
      }
      if (input === "/") {
        // Open full-text search from either browse screen.
        if (mode === "projects" || mode === "sessions") {
          setMode("search");
          return;
        }
      }
      if (input === "d") {
        // Open the dashboard (running sessions + headline stats) from browse.
        if (mode === "projects" || mode === "sessions") {
          setMode("dashboard");
          return;
        }
      }
      if (mode === "projects") {
        if (key.downArrow || input === "j") setPIdx((i) => Math.min(i + 1, projects.length - 1));
        else if (key.upArrow || input === "k") setPIdx((i) => Math.max(i - 1, 0));
        else if (input === "c") {
          // Open a live chat against the highlighted project.
          const p = projects[pIdx];
          if (p) {
            setProject(p);
            setChatReturn("projects");
            setMode("chat");
          }
        } else if (key.return) {
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
        else if (input === "c") {
          // Live chat against this project (current cwd grouping).
          if (project) {
            setChatReturn("sessions");
            setMode("chat");
          }
        } else if (key.escape || input === "h") setMode("projects");
        else if (key.return) {
          const s = sessions[sIdx];
          if (s) openTranscript({ sessionId: s.sessionId, title: s.title, cwd: s.cwd }, "sessions");
        }
      } else if (mode === "transcript") {
        if (key.downArrow || input === "j") setScroll((s) => Math.min(s + 1, Math.max(0, rows.length - VISIBLE)));
        else if (key.upArrow || input === "k") setScroll((s) => Math.max(0, s - 1));
        else if (input === " ") setScroll((s) => Math.min(s + VISIBLE, Math.max(0, rows.length - VISIBLE)));
        else if (key.escape || input === "h") setMode(transcriptReturn);
      }
    },
    // While the Chat, Search, or Dashboard screen is mounted it owns keyboard
    // input; the browse handler is disabled so typed characters (incl.
    // "q"/"c"/"/"/"d") go to that screen instead of triggering browse shortcuts.
    { isActive: mode !== "chat" && mode !== "search" && mode !== "dashboard" },
  );

  if (mode === "chat" && project) {
    // The Chat screen owns its own header/footer + keyboard input. Esc returns
    // to the browse screens (sessions when we came from there, else projects).
    return (
      <Box flexDirection="column" paddingX={1}>
        <Chat project={project} onExit={() => setMode(chatReturn)} />
      </Box>
    );
  }

  if (mode === "search") {
    // The Search screen owns its own input. A hit opens the session's transcript
    // (Esc from there returns to the search results); Esc here returns to browse.
    return (
      <Box flexDirection="column" paddingX={1}>
        <Search
          engine={engine}
          onOpen={(hit) => openTranscript({ sessionId: hit.sessionId, title: hit.title, cwd: hit.cwd }, "search")}
          onExit={() => setMode("projects")}
        />
      </Box>
    );
  }

  if (mode === "dashboard") {
    // The Dashboard screen owns its own input (r refresh, esc/h back). It reads
    // running sessions + headline stats in-process; Esc returns to browse.
    return (
      <Box flexDirection="column" paddingX={1}>
        <Dashboard engine={engine} onExit={() => setMode("projects")} />
      </Box>
    );
  }

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
            {head?.title}
          </Text>
          <Text color="gray">{head?.cwd ?? ""}</Text>
          <Box flexDirection="column" marginTop={1}>
            {loading ? (
              <Text color="gray">loading…</Text>
            ) : (
              <Transcript rows={rows} scroll={scroll} visible={VISIBLE} />
            )}
          </Box>
          <Text color="gray">
            {"\n"}
            {rows.length ? `${scroll + 1}-${Math.min(scroll + VISIBLE, rows.length)} / ${rows.length}` : ""}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          {mode === "projects"
            ? "↑↓/jk move · ⏎ open · c chat · / search · d dashboard · q quit"
            : mode === "sessions"
              ? "↑↓/jk move · ⏎ open · c chat · / search · d dashboard · esc/h back · q quit"
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
