"use client";

import { buttonVariants } from "@ratel/design-system/button-variants";
import { Popover, PopoverContent, PopoverTrigger } from "@ratel/design-system/popover";
import { ChevronDown } from "lucide-react";
import { AgentOverrideControls } from "./AgentOverrideControls";

/** What an admin's corrections need (RC-776): the write route, the current name and the merge targets. */
export type AgentEditModel = {
  apiHref: string;
  /** The override name; null when the agent shows its detected key. */
  displayName: string | null;
  mergeTargets: { key: string; name: string }[];
};

/**
 * "Edit agent" (the approved RP-25 design): the admin's corrections (display name, "Same agent
 * as", hide) move out of the page into one header menu, so the page leads with what the agent
 * does. Upstream's `AgentOverrideControls` inside; the page renders it for admins only.
 */
export function AgentEditMenu({
  edit,
  agentKey,
  hidden,
  mergedKeys,
}: {
  edit: AgentEditModel;
  agentKey: string;
  hidden: boolean;
  mergedKeys: readonly string[];
}) {
  return (
    <Popover>
      <PopoverTrigger className={buttonVariants({ variant: "secondary", size: "md" })}>
        Edit agent
        <ChevronDown aria-hidden className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem]" title="Edit agent">
        <p className="mb-3 text-xs text-fg-subtle">
          Detected as <span className="font-mono text-fg-muted">{agentKey}</span>
        </p>
        <AgentOverrideControls
          key={agentKey}
          apiHref={edit.apiHref}
          agentKey={agentKey}
          displayName={edit.displayName}
          hidden={hidden}
          mergedKeys={mergedKeys}
          mergeTargets={edit.mergeTargets}
        />
        <p className="mt-3 border-t border-line pt-3 text-xs text-fg-subtle">
          Changes only how the agent shows. Detection stays automatic. Admins only.
        </p>
      </PopoverContent>
    </Popover>
  );
}
