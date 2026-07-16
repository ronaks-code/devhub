import { useEffect, useId, useRef, useState } from "react";
import { GitFork } from "lucide-react";
import { Spinner } from "../../ui.js";
import {
  PERMISSION_FIELD_LABEL,
  providerIdentity,
  type ProviderId,
} from "../providers/provider-capabilities.js";
import type {
  CrossProviderForkCommitResult,
  CrossProviderForkPreviewResult,
  CrossProviderForkTargetInput,
} from "../../../lib/provider-api.js";

/**
 * CrossProviderForkPanel — the M7 cross-provider fork preview/commit UI (concept
 * 06, production clarification in
 * `.planning/devhub-codex-parity/concepts/06-cross-provider-fork-brief.md`).
 *
 * Three stages, matching the brief exactly:
 *
 *  1. Unchanged source — the entry point button itself (`Create cross-provider
 *     fork`). Behind the default-off `crossProviderFork` flag: when `enabled` is
 *     `false` this component renders NOTHING — no button, no dialog can ever
 *     open. This is the ONLY gate; there is no other way to reach the dialog.
 *  2. Reviewed handoff preview — built by the caller-supplied `fetchPreview()`
 *     (the M7-FORK-SERVER `fork-preview` endpoint via `ProviderApiClient`). Shows
 *     target provider/model/mode/folder + the provider-derived permission field
 *     (`Permission mode` for Claude, `Permissions` for Codex — NEVER
 *     `Workspace`, which the brief explicitly rejects for a Claude target), the
 *     attributed transferred-context body, and a LOCKED, non-interactive
 *     "Excluded automatically" list (rendered as plain text, never a selectable
 *     control). `Cancel` discards the preview without ever calling
 *     `commitPreview`; `Create fork` calls it.
 *  3. New native target — rendered from the caller-supplied `commitPreview()`
 *     resolution (the `fork-commit` endpoint): target identity, the new native
 *     task id, `Forked from <source>`, and `Linked by DevHub`.
 *
 * This component owns no networking itself — `fetchPreview`/`commitPreview` are
 * injected so the real wiring (a real `NativeTaskKey`, a real
 * `ProviderApiClient`) lives entirely in the caller (composition), and this file
 * stays a pure, fully unit-testable UI contract.
 */

export const CROSS_PROVIDER_FORK_COPY = Object.freeze({
  entryLabel: "Create cross-provider fork",
  sourceTaskLabel: "Source task",
  targetProviderLabel: "Target provider",
  requestedModelLabel: "Requested model",
  runtimeDefaultModel: "Runtime default",
  modeLabel: "Mode",
  defaultMode: "Code",
  folderLabel: "Folder",
  defaultPermissionValue: "Default",
  transferredContextLabel: "Transferred context",
  excludedLabel: "Excluded automatically",
  disclosureUnchanged: "The source task remains unchanged. A new native task will be created.",
  disclosureLocal: "The resulting link is local to DevHub.",
  cancel: "Cancel",
  createFork: "Create fork",
  creating: "Creating fork…",
  buildingPreview: "Building the handoff preview…",
  forkedFromPrefix: "Forked from",
  linkedByDevHub: "Linked by DevHub",
  done: "Done",
  retry: "Retry",
} as const);

/**
 * The allowlisted exclusion categories the brief requires as a LOCKED,
 * non-interactive disclosure. This is presentational only — the real exclusion
 * enforcement happens server-side in the engine's allowlist (`cross-provider-fork.ts`);
 * this list documents it to the reviewer and is never rendered as a
 * checkbox/selectable control.
 */
export const CROSS_PROVIDER_FORK_EXCLUDED_CATEGORIES = Object.freeze([
  "Secrets and auth",
  "Hidden reasoning",
  "Approval credentials",
  "Unreviewed sensitive tool output",
] as const);

export interface CrossProviderForkSource {
  provider: ProviderId;
  /** Shown in the preview's "Source task" row and the attributed handoff body. */
  title: string;
  nativeTaskId: string;
}

export interface CrossProviderForkPanelProps {
  /**
   * The `crossProviderFork` feature flag. `false` hides the entry point
   * ENTIRELY — no button renders and the dialog can never open. This is the
   * component's only gate.
   */
  enabled: boolean;
  source: CrossProviderForkSource;
  /** The target descriptor the preview/commit calls are built against. */
  target: CrossProviderForkTargetInput;
  fetchPreview: () => Promise<CrossProviderForkPreviewResult>;
  commitPreview: (previewId: string) => Promise<CrossProviderForkCommitResult>;
  onCommitted?: (result: CrossProviderForkCommitResult) => void;
  className?: string;
}

type Stage =
  | { kind: "closed" }
  | { kind: "loading" }
  | { kind: "preview"; data: CrossProviderForkPreviewResult }
  | { kind: "committing"; data: CrossProviderForkPreviewResult }
  | {
      kind: "result";
      data: CrossProviderForkPreviewResult;
      result: CrossProviderForkCommitResult;
    }
  | { kind: "error"; message: string; retry: "preview" | "commit"; data?: CrossProviderForkPreviewResult };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

export function CrossProviderForkPanel({
  enabled,
  source,
  target,
  fetchPreview,
  commitPreview,
  onCommitted,
  className,
}: CrossProviderForkPanelProps) {
  const [stage, setStage] = useState<Stage>({ kind: "closed" });
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const busy = stage.kind === "loading" || stage.kind === "committing";

  const openPreview = async () => {
    setStage({ kind: "loading" });
    try {
      const data = await fetchPreview();
      setStage({ kind: "preview", data });
    } catch (error) {
      setStage({
        kind: "error",
        message: errorMessage(error, "Couldn't build the cross-provider fork preview."),
        retry: "preview",
      });
    }
  };

  const close = () => setStage({ kind: "closed" });

  const confirm = async (data: CrossProviderForkPreviewResult) => {
    setStage({ kind: "committing", data });
    try {
      const result = await commitPreview(data.previewId);
      setStage({ kind: "result", data, result });
      onCommitted?.(result);
    } catch (error) {
      setStage({
        kind: "error",
        message: errorMessage(error, "Couldn't create the cross-provider fork."),
        retry: "commit",
        data,
      });
    }
  };

  useEffect(() => {
    if (stage.kind === "closed") return;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.kind]);

  // The ONLY gate: flag-off means this component renders nothing at all — no
  // entry point button, no dialog reachable by any interaction.
  if (!enabled) return null;

  const sourceIdentity = providerIdentity(source.provider);
  const targetIdentity = providerIdentity(target.provider);
  const permissionLabel = PERMISSION_FIELD_LABEL[target.provider];

  return (
    <>
      <button
        type="button"
        data-cpf-entry=""
        onClick={() => void openPreview()}
        className={
          className ??
          "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-500/50"
        }
      >
        <GitFork className="h-3.5 w-3.5" aria-hidden="true" />
        {CROSS_PROVIDER_FORK_COPY.entryLabel}
      </button>

      {stage.kind !== "closed" ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) close();
          }}
        >
          <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            data-cpf-dialog=""
            className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl"
          >
            {stage.kind === "loading" ? (
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <Spinner className="h-4 w-4" /> {CROSS_PROVIDER_FORK_COPY.buildingPreview}
              </div>
            ) : null}

            {stage.kind === "error" ? (
              <div>
                <div id={titleId} className="text-sm font-medium text-amber-200">
                  {CROSS_PROVIDER_FORK_COPY.entryLabel}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-zinc-500">{stage.message}</p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={close}
                    className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200"
                  >
                    {CROSS_PROVIDER_FORK_COPY.cancel}
                  </button>
                  <button
                    type="button"
                    onClick={() => void (stage.retry === "preview" ? openPreview() : confirm(stage.data!))}
                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white"
                  >
                    {CROSS_PROVIDER_FORK_COPY.retry}
                  </button>
                </div>
              </div>
            ) : null}

            {stage.kind === "preview" || stage.kind === "committing" ? (
              <PreviewStage
                titleId={titleId}
                source={source}
                sourceLabel={sourceIdentity.label}
                targetLabel={targetIdentity.label}
                permissionLabel={permissionLabel}
                preview={stage.data.preview}
                busy={stage.kind === "committing"}
                onCancel={close}
                onConfirm={() => void confirm(stage.data)}
              />
            ) : null}

            {stage.kind === "result" ? (
              <ResultStage
                titleId={titleId}
                sourceLabel={sourceIdentity.label}
                targetLabel={targetIdentity.label}
                nativeTaskId={stage.result.targetTask.key.nativeTaskId}
                onDone={close}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function attributedHandoffBody(
  sourceLabel: string,
  source: CrossProviderForkSource,
  preview: CrossProviderForkPreviewResult["preview"],
): string {
  const heading = `Handoff from ${sourceLabel} task ${source.nativeTaskId}`;
  if (preview.transferredContext.messages.length === 0) return heading;
  const body = preview.transferredContext.messages
    .map((message) => `[${message.role}] ${message.text}`)
    .join("\n\n");
  return `${heading}\n\n${body}`;
}

function PreviewStage({
  titleId,
  source,
  sourceLabel,
  targetLabel,
  permissionLabel,
  preview,
  busy,
  onCancel,
  onConfirm,
}: {
  titleId: string;
  source: CrossProviderForkSource;
  sourceLabel: string;
  targetLabel: string;
  permissionLabel: string;
  preview: CrossProviderForkPreviewResult["preview"];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const handoffBody = attributedHandoffBody(sourceLabel, source, preview);
  return (
    <div>
      <div id={titleId} className="text-sm font-medium text-zinc-100">
        {CROSS_PROVIDER_FORK_COPY.entryLabel}
      </div>

      <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-zinc-500">{CROSS_PROVIDER_FORK_COPY.sourceTaskLabel}</dt>
        <dd className="text-zinc-200" data-cpf-source-provider="">{sourceLabel}</dd>
        <dt className="text-zinc-500">{CROSS_PROVIDER_FORK_COPY.targetProviderLabel}</dt>
        <dd className="text-zinc-200" data-cpf-target-provider="">{targetLabel}</dd>
        <dt className="text-zinc-500">{CROSS_PROVIDER_FORK_COPY.requestedModelLabel}</dt>
        <dd className="text-zinc-200">{preview.targetModel ?? CROSS_PROVIDER_FORK_COPY.runtimeDefaultModel}</dd>
        <dt className="text-zinc-500">{CROSS_PROVIDER_FORK_COPY.modeLabel}</dt>
        <dd className="text-zinc-200">{preview.targetMode ?? CROSS_PROVIDER_FORK_COPY.defaultMode}</dd>
        <dt className="text-zinc-500">{CROSS_PROVIDER_FORK_COPY.folderLabel}</dt>
        <dd className="truncate text-zinc-200" title={preview.targetCwd}>{preview.targetCwd}</dd>
        {/* Provider-derived permission LABEL only — Claude never reads `Permissions /
            Workspace`; the brief's production rejection explicitly forbids it. */}
        <dt className="text-zinc-500">{permissionLabel}</dt>
        <dd className="text-zinc-200">{CROSS_PROVIDER_FORK_COPY.defaultPermissionValue}</dd>
      </dl>

      <div className="mt-3">
        <div className="text-[11px] font-medium text-zinc-400">
          {CROSS_PROVIDER_FORK_COPY.transferredContextLabel}
        </div>
        <pre
          data-cpf-handoff-body=""
          className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-zinc-900 p-2 text-[11px] leading-relaxed text-zinc-300"
        >
          {handoffBody}
        </pre>
      </div>

      <div className="mt-3">
        <div className="text-[11px] font-medium text-zinc-400">
          {CROSS_PROVIDER_FORK_COPY.excludedLabel}
        </div>
        {/* Locked, non-interactive: never a checkbox/button/select. */}
        <ul data-cpf-excluded="" aria-readonly="true" className="mt-1 list-disc pl-4 text-[11px] text-zinc-500">
          {CROSS_PROVIDER_FORK_EXCLUDED_CATEGORIES.map((category) => (
            <li key={category}>{category}</li>
          ))}
        </ul>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
        {CROSS_PROVIDER_FORK_COPY.disclosureUnchanged}
        <br />
        {CROSS_PROVIDER_FORK_COPY.disclosureLocal}
      </p>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 disabled:opacity-40"
        >
          {CROSS_PROVIDER_FORK_COPY.cancel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          {busy ? CROSS_PROVIDER_FORK_COPY.creating : CROSS_PROVIDER_FORK_COPY.createFork}
        </button>
      </div>
    </div>
  );
}

function ResultStage({
  titleId,
  sourceLabel,
  targetLabel,
  nativeTaskId,
  onDone,
}: {
  titleId: string;
  sourceLabel: string;
  targetLabel: string;
  nativeTaskId: string;
  onDone: () => void;
}) {
  return (
    <div>
      <div id={titleId} className="text-sm font-medium text-zinc-100" data-cpf-target-identity="">
        {targetLabel}
      </div>
      <p className="mt-1 text-xs text-zinc-400" data-cpf-target-native-id="">{nativeTaskId}</p>
      <p className="mt-3 text-xs text-zinc-300">
        {CROSS_PROVIDER_FORK_COPY.forkedFromPrefix} {sourceLabel}
      </p>
      <p className="text-xs text-zinc-500">{CROSS_PROVIDER_FORK_COPY.linkedByDevHub}</p>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onDone}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white"
        >
          {CROSS_PROVIDER_FORK_COPY.done}
        </button>
      </div>
    </div>
  );
}
