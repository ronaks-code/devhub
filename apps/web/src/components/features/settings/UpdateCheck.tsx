import { useState } from "react";
import { Field } from "./settings-ui.js";

/**
 * Settings → "Check for updates". In the desktop app this checks GitHub Releases via
 * the Tauri updater, downloads + installs the signed update, and relaunches. In the
 * plain web build the updater plugin isn't present, so it shows a note instead. The
 * plugin modules are imported dynamically (only inside Tauri) so the web bundle never
 * pulls them in; an async click handler has no live-gesture constraint, unlike drag.
 */
export function UpdateCheck() {
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const run = async () => {
    setBusy(true);
    setStatus("Checking for updates…");
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        setStatus("You're on the latest version.");
        return;
      }
      setStatus(`Update ${update.version} available — downloading…`);
      await update.downloadAndInstall();
      setStatus("Update installed — restarting…");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      setStatus(`Update check failed: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field
      id="dh-settings-updates"
      label="Check for updates"
      hint="Downloads and installs the latest signed DevHub release, then restarts."
    >
      {isTauri ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            onClick={run}
            disabled={busy}
            style={{
              padding: "6px 12px",
              borderRadius: 8,
              border: "1px solid var(--dh-glass-border)",
              background: "var(--dh-hover)",
              color: "var(--dh-text)",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
              font: "inherit",
            }}
          >
            {busy ? "Working…" : "Check for updates"}
          </button>
          {status ? (
            <span
              className="dh-settings-fieldgroup-description"
              style={{ margin: 0 }}
            >
              {status}
            </span>
          ) : null}
        </div>
      ) : (
        <span
          className="dh-settings-fieldgroup-description"
          style={{ margin: 0 }}
        >
          Available in the desktop app only.
        </span>
      )}
    </Field>
  );
}
