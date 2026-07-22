import { type ChangeEvent, type ReactNode } from "react";
import { cn } from "../../../lib/utils.js";
import { nextTabIndex } from "../inspectors/InspectorDock.js";

/**
 * settings-ui — the audited primitive set named by `design-lock.md` §8 /
 * `component-state-matrix.md` §13 / `surface-inventory.md` `RT-07`:
 * `Tabs`/`FieldGroup`/`Field`/`FieldSet`/`Select`/`Input`/`Switch`/`Button`/`Alert`/
 * `Progress`/`Table`/`Dialog`.
 *
 * TOOLING (honest, mirrors the M6 Task 7 note): no M6 task has installed shadcn/
 * Radix/cmdk packages anywhere in this repo (`apps/web/package.json` carries zero
 * `@radix-ui`/`cmdk` deps; no `components.json`/`ui/` folder exists). This file is
 * a hand-rolled, ARIA-correct implementation of the SAME named primitive set,
 * matching the established convention every prior M6 slice used, so the Settings
 * surface does not become an inconsistent one-off partial shadcn adoption. Every
 * primitive here is a plain styled semantic element — never a generic bordered
 * "form card" — and reuses the shared `nextTabIndex` roving-focus helper from
 * `InspectorDock` rather than re-deriving tab-roving math.
 */

export interface SettingsTabItem<TId extends string = string> {
  id: TId;
  label: string;
}

/**
 * A rail grouping (§3.4 IDE-Rail): an uppercase mono header (`AGENTS`/`CONFIG`/
 * `DATA`) above the tabs that belong to it. Purely presentational — the tablist
 * still owns exactly one roving tabstop across ALL tabs, so keyboard nav and the
 * `role="tab"` count are unchanged whether or not groups are supplied.
 */
export interface SettingsTabGroup<TId extends string = string> {
  label: string;
  tabIds: ReadonlyArray<TId>;
}

/** A single roving-tabstop `role="tablist"` (Left/Right/Home/End), one tab active. */
export function Tabs<TId extends string>({
  id,
  label,
  tabs,
  active,
  onSelect,
  groups,
  footer,
}: {
  id: string;
  label: string;
  tabs: ReadonlyArray<SettingsTabItem<TId>>;
  active: TId;
  onSelect: (id: TId) => void;
  /**
   * Optional rail groupings. When present, tabs render under their group header
   * in the concatenated `tabIds` order; the `tabs` array MUST already be in that
   * same order so keyboard roving (which walks `tabs`) matches the visual order.
   * Omit for the flat (ungrouped) list.
   */
  groups?: ReadonlyArray<SettingsTabGroup<TId>>;
  /** Optional mono rail footer (e.g. app version / config path), rendered last. */
  footer?: ReactNode;
}): ReactNode {
  const activeIndex = Math.max(tabs.findIndex((t) => t.id === active), 0);
  const byId = new Map(tabs.map((t) => [t.id, t] as const));

  const renderTab = (tab: SettingsTabItem<TId>) => {
    const i = tabs.findIndex((t) => t.id === tab.id);
    return (
      <button
        key={tab.id}
        type="button"
        role="tab"
        id={`${id}-${tab.id}`}
        aria-selected={tab.id === active}
        aria-controls={`${id}-${tab.id}-panel`}
        tabIndex={i === activeIndex ? 0 : -1}
        className="dh-settings-tab"
        data-dh-settings-tab={tab.id}
        onClick={() => onSelect(tab.id)}
      >
        {tab.label}
      </button>
    );
  };

  const body =
    groups && groups.length > 0
      ? groups.map((group) => {
          const groupTabs = group.tabIds
            .map((tid) => byId.get(tid))
            .filter((t): t is SettingsTabItem<TId> => Boolean(t));
          if (groupTabs.length === 0) return null;
          return (
            <div key={group.label} role="presentation" className="dh-settings-tab-group" data-dh-settings-tab-group={group.label}>
              <span
                className="dh-settings-tab-group-label"
                style={{
                  padding: "10px 11px 4px",
                  fontSize: "10px",
                  fontWeight: 700,
                  letterSpacing: "0.09em",
                  textTransform: "uppercase",
                  color: "var(--dh-text-dim)",
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                }}
              >
                {group.label}
              </span>
              {groupTabs.map((t) => renderTab(t))}
            </div>
          );
        })
      : tabs.map((tab) => renderTab(tab));

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      id={id}
      className="dh-settings-tablist"
      data-dh-settings-tablist=""
      onKeyDown={(event) => {
        const key = event.key;
        if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
        event.preventDefault();
        const next = nextTabIndex(key, activeIndex, tabs.length);
        const target = tabs[next];
        if (target) onSelect(target.id);
      }}
    >
      {body}
      {footer ? (
        <div role="presentation" className="dh-settings-rail-footer" data-dh-settings-rail-footer="">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/** The single `role="tabpanel"` that goes with one `Tabs` selection. */
export function TabPanel({
  id,
  tabId,
  children,
}: {
  id: string;
  tabId: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div
      role="tabpanel"
      id={`${id}-${tabId}-panel`}
      aria-labelledby={`${id}-${tabId}`}
      tabIndex={0}
      className="dh-settings-panel"
      data-dh-settings-panel={tabId}
    >
      {children}
    </div>
  );
}

/** A named accessible group of fields (`aria-labelledby` a real heading) — NOT a generic bordered card. */
export function FieldGroup({
  id,
  heading,
  description,
  children,
}: {
  id: string;
  heading: string;
  description?: string;
  children?: ReactNode;
}): ReactNode {
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} className="dh-settings-fieldgroup" data-dh-fieldgroup={id}>
      <h2 id={headingId} className="dh-settings-fieldgroup-heading">
        {heading}
      </h2>
      {description ? <p className="dh-settings-fieldgroup-description">{description}</p> : null}
      <div className="dh-settings-fieldgroup-body">{children}</div>
    </section>
  );
}

/** A native `<fieldset>` sub-grouping inside a `FieldGroup` (e.g. Connection). */
export function FieldSet({
  legend,
  disabled,
  children,
}: {
  legend: string;
  disabled?: boolean;
  children?: ReactNode;
}): ReactNode {
  return (
    <fieldset disabled={disabled} className="dh-settings-fieldset" data-dh-fieldset="">
      <legend className="dh-settings-legend">{legend}</legend>
      {children}
    </fieldset>
  );
}

/** One labelled control row: a real bound `<label for>` plus optional hint/error. */
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="dh-settings-field" data-dh-field={id}>
      <label htmlFor={id} className="dh-settings-field-label">
        {label}
      </label>
      {children}
      {hint ? (
        <span id={`${id}-hint`} className="dh-settings-field-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} role="alert" className="dh-settings-field-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Build the `aria-describedby` value for a `Field` with an optional hint and/or error. */
export function fieldDescribedBy(id: string, opts: { hint?: string; error?: string }): string | undefined {
  const ids = [opts.hint ? `${id}-hint` : undefined, opts.error ? `${id}-error` : undefined].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

export function Select({
  id,
  value,
  options,
  describedBy,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  describedBy?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <select
      id={id}
      className="dh-settings-select"
      value={value}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export function Input({
  id,
  type = "text",
  value,
  placeholder,
  describedBy,
  disabled,
  onChange,
}: {
  id: string;
  type?: "text" | "password" | "number";
  value: string;
  placeholder?: string;
  describedBy?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <input
      id={id}
      type={type}
      className="dh-settings-input"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-describedby={describedBy}
      autoComplete={type === "password" ? "off" : undefined}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
    />
  );
}

/** A `role="switch"` checkbox — the accessible toggle contract used across settings. */
export function Switch({
  id,
  label,
  checked,
  describedBy,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  describedBy?: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <input
      id={id}
      type="checkbox"
      role="switch"
      aria-label={label}
      aria-describedby={describedBy}
      checked={checked}
      disabled={disabled}
      className="dh-settings-switch"
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
    />
  );
}

export function Button({
  type = "button",
  variant = "default",
  disabled,
  onClick,
  autoFocus,
  children,
}: {
  type?: "button" | "submit";
  variant?: "default" | "ghost" | "danger";
  disabled?: boolean;
  onClick?: () => void;
  autoFocus?: boolean;
  children?: ReactNode;
}): ReactNode {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      autoFocus={autoFocus}
      className={cn("dh-settings-button", `dh-settings-button-${variant}`)}
    >
      {children}
    </button>
  );
}

/** A persistent alert region (never a transient toast) for load/save errors. */
export function Alert({
  tone = "error",
  children,
}: {
  tone?: "error" | "info";
  children?: ReactNode;
}): ReactNode {
  return (
    <div role="alert" className={cn("dh-settings-alert", `dh-settings-alert-${tone}`)}>
      {children}
    </div>
  );
}

/** A bounded, labelled progress indicator for an in-flight save/maintenance op. */
export function Progress({ label }: { label: string }): ReactNode {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-busy="true"
      className="dh-settings-progress"
      data-dh-settings-progress=""
    >
      <span className="dh-settings-progress-bar" />
    </div>
  );
}

/** A semantic `<table>` — used for the provider-capability status rows, never for layout. */
export function Table({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: ReadonlyArray<string>;
  rows: ReadonlyArray<{ key: string; cells: ReadonlyArray<ReactNode> }>;
}): ReactNode {
  return (
    <table className="dh-settings-table" data-dh-settings-table="">
      <caption className="dh-sr-only">{caption}</caption>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c} scope="col">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} data-dh-settings-table-row={row.key}>
            {row.cells.map((cell, j) => (
              <td key={j}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A confirmation dialog panel. The caller owns the outer overlay/backdrop (App's
 * overlay tree, staged for the Task 9 cutover, mirrors `TaskSearchDialog`/
 * `CommandDialog`) and MUST focus `cancelRef`'s button first — see
 * `describeClearLocalDataConfirmation` for the pure copy/focus contract.
 */
export function Dialog({
  titleId,
  title,
  children,
  footer,
}: {
  titleId: string;
  title: string;
  children?: ReactNode;
  footer: ReactNode;
}): ReactNode {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="dh-dialog dh-settings-dialog"
      data-dh-settings-dialog=""
    >
      <h2 id={titleId} className="dh-settings-dialog-title">
        {title}
      </h2>
      <div className="dh-settings-dialog-body">{children}</div>
      <div className="dh-dialog-footer dh-settings-dialog-footer">{footer}</div>
    </div>
  );
}
