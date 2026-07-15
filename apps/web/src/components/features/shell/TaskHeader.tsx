import {
  TASK_HEADER_COPY,
  providerIdentity,
  resolveClaudeModelDisclosure,
  type ClaudeModelReport,
  type ProviderId,
} from "../providers/provider-capabilities.js";

/**
 * TaskHeader — the existing-task 46-high header (M6 slice 3, design-lock §3/§5).
 *
 * The header shows a compact truncating task title plus QUIET provider identity as
 * read-only text (`OpenAI · Codex` / `Anthropic · Claude`). There is NO editable
 * provider control anywhere in an existing task — provider is immutable after
 * creation (invariant 1). The only way to change provider is `Create cross-provider
 * fork`, which produces a new provider task and leaves this one unchanged.
 *
 * For a Claude task only, when the requested model diverges from the session-reported
 * or response-used model, the header surfaces all three under their own labels plus
 * the exact copy `Model differs from request`; it never claims the requested model
 * ran. A Codex task never renders any Claude divergence copy (a permanently visible
 * Claude warning beside a Codex task is rejected — design-lock §13).
 *
 * Renders no `<svg>`/`<img>` — provider identity is quiet text, never a logo.
 */
export interface TaskHeaderProps {
  title: string;
  /** Immutable-after-creation provider identity. */
  provider: ProviderId;
  /** Claude model observations. Only meaningful/used when provider is `anthropic`. */
  claudeModel?: ClaudeModelReport;
  /** Route a provider change to the cross-provider fork flow (M7); never mutates source. */
  onFork?: () => void;
}

export function TaskHeader({ title, provider, claudeModel, onFork }: TaskHeaderProps) {
  const identity = providerIdentity(provider);
  // Claude divergence is Claude-only. A Codex task computes nothing here, so no Claude
  // copy can ever leak beside a Codex task.
  const disclosure =
    provider === "anthropic" && claudeModel
      ? resolveClaudeModelDisclosure(claudeModel)
      : null;

  return (
    <header className="dh-task-header" data-dh-task-header="" data-dh-provider={provider}>
      <div className="dh-task-header-main">
        <h1 className="dh-task-header-title" data-dh-task-title="" title={title}>
          {title}
        </h1>
        {/* Quiet read-only provider identity. NOT a picker/select/toggle. */}
        <span
          className="dh-task-header-provider"
          data-dh-provider-identity=""
          data-dh-provider-immutable="true"
        >
          {identity.label}
        </span>
      </div>

      <div className="dh-task-header-actions">
        {/* Provider change is only a fork; the source task is never mutated. */}
        <button
          type="button"
          className="dh-task-header-fork"
          data-dh-fork-provider=""
          onClick={() => onFork?.()}
        >
          {TASK_HEADER_COPY.forkAction}
        </button>
        <span className="dh-sr-only" data-dh-provider-fixed-note="">
          {TASK_HEADER_COPY.providerFixedNote}
        </span>
      </div>

      {disclosure && disclosure.diverges ? (
        <div className="dh-task-model-divergence" data-dh-model-divergence="" role="note">
          {/* Each observed model under its own label; the requested model is NEVER
              relabeled as the one that ran. */}
          <span className="dh-model-line" data-dh-model-requested="">
            <span className="dh-model-label">{TASK_HEADER_COPY.requestedLabel}</span>
            <span className="dh-model-value">{disclosure.requested ?? "—"}</span>
          </span>
          {disclosure.sessionReported != null ? (
            <span className="dh-model-line" data-dh-model-session="">
              <span className="dh-model-label">{TASK_HEADER_COPY.sessionReportedLabel}</span>
              <span className="dh-model-value">{disclosure.sessionReported}</span>
            </span>
          ) : null}
          {disclosure.responseUsed != null ? (
            <span className="dh-model-line" data-dh-model-response="">
              <span className="dh-model-label">{TASK_HEADER_COPY.responseUsedLabel}</span>
              <span className="dh-model-value">{disclosure.responseUsed}</span>
            </span>
          ) : null}
          <span className="dh-model-warning" data-dh-model-warning="">
            {disclosure.message}
          </span>
        </div>
      ) : null}
    </header>
  );
}
