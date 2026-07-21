import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Shared provider chip (Aurora Cockpit §1.1E). A mono uppercase pill carrying the
 * provider's identity as LETTERS (CLD / CDX) tinted with its accent — so the
 * identity survives without relying on color alone. Never a provider logo.
 *
 * `provider` is the normalized engine value; `anthropic` reads "CLD" (coral),
 * `openai` reads "CDX" (mint). An explicit `label` overrides the derived text.
 */
export type ChipProvider = "anthropic" | "openai";

const PROVIDER_CLASS: Record<ChipProvider, string> = {
  anthropic: "dh-provider-chip--anthropic",
  openai: "dh-provider-chip--openai",
};

const PROVIDER_LABEL: Record<ChipProvider, string> = {
  anthropic: "CLD",
  openai: "CDX",
};

const PROVIDER_NAME: Record<ChipProvider, string> = {
  anthropic: "Claude",
  openai: "Codex",
};

export interface ProviderChipProps extends React.ComponentProps<"span"> {
  provider: ChipProvider;
  /** Override the derived CLD/CDX text (rarely needed). */
  label?: string;
}

export function ProviderChip({ provider, label, className, ...props }: ProviderChipProps) {
  return (
    <span
      data-slot="provider-chip"
      data-provider={provider}
      className={cn("dh-provider-chip", PROVIDER_CLASS[provider], className)}
      title={PROVIDER_NAME[provider]}
      {...props}
    >
      {label ?? PROVIDER_LABEL[provider]}
    </span>
  );
}
