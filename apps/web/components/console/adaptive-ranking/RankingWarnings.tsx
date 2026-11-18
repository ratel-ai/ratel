"use client";

import { Button } from "@ratel/design-system/button";
import { Disclosure } from "@ratel/design-system/disclosure";
import { Callout } from "@ratel/design-system/states";
import { X } from "lucide-react";
import { useStoredFlag } from "@/components/console/health/use-stored-flag";

export type RankingWarningView = {
  text: string;
  /** Tools the sentence counts, listed behind a toggle. */
  tools?: string[];
  /** Set when the warning can be closed; it returns once its content changes. */
  fingerprint?: string;
};

/**
 * The graph's warnings with `cloud-ranking-catalog-drift` on (RC-723, RC-724):
 * one callout each, the tool list on demand, and a close that holds for this
 * viewer until the warning says something new.
 */
export function RankingWarnings({
  projectId,
  graphKey,
  warnings,
}: {
  projectId: string;
  graphKey: string;
  warnings: readonly RankingWarningView[];
}) {
  return (
    <div className="flex flex-col gap-3">
      {warnings.map((warning) => (
        <RankingWarningCallout
          key={warning.fingerprint ?? warning.text}
          storageKey={
            warning.fingerprint
              ? `ratel:ranking-warning-closed:${projectId}:${graphKey}:${warning.fingerprint}`
              : null
          }
          warning={warning}
        />
      ))}
    </div>
  );
}

function RankingWarningCallout({
  storageKey,
  warning,
}: {
  storageKey: string | null;
  warning: RankingWarningView;
}) {
  const [closed, setClosed] = useStoredFlag(storageKey ?? "ratel:ranking-warning-closed:none");
  if (storageKey && closed) return null;
  const tools = warning.tools ?? [];
  return (
    <Callout
      tone="warning"
      title="Worth a look"
      action={
        storageKey ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close this warning"
            onClick={() => setClosed(true)}
          >
            <X aria-hidden />
          </Button>
        ) : null
      }
    >
      <p>{warning.text}</p>
      {tools.length > 0 ? (
        <Disclosure
          title={
            tools.length === 1
              ? "Show the tool"
              : `Show the ${tools.length.toLocaleString("en-US")} tools`
          }
          className="mt-1"
        >
          <ul
            data-ranking-warning-tools=""
            className="flex max-h-64 flex-col gap-0.5 overflow-y-auto font-mono text-xs text-fg-muted"
          >
            {tools.map((tool) => (
              <li key={tool}>{tool}</li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </Callout>
  );
}
