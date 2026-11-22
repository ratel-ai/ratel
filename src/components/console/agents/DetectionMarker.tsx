"use client";

import { Badge } from "@ratel/design-system/badge";
import { Tooltip } from "@ratel/design-system/tooltip";
import { CircleHelp } from "lucide-react";
import { type Detection, explainDetection } from "@/lib/views/entities/detection";

/**
 * How Ratel detected an agent, MCP server or client (RC-779). A guess shows a
 * warning badge whose tooltip names the rule that matched and the attribute
 * that makes the detection explicit. An explicit source (the Ratel SDK, an
 * OpenTelemetry attribute) shows a neutral badge with `showExplicit`, else
 * nothing: lists mark only the guesses. The trigger is a button, so the
 * marker is focusable and its label passes this repository's a11y lint.
 */
export function DetectionMarker({
  detection,
  showExplicit = false,
}: {
  detection: Detection | null;
  showExplicit?: boolean;
}) {
  if (!detection) return null;
  const explained = explainDetection(detection);
  const guessed = explained.tone === "warning";
  if (!guessed && !showExplicit) return null;
  const summary = guessed ? `Guessed ${explained.rule}.` : `Detected ${explained.rule}.`;
  return (
    <Tooltip
      content={
        <span className="flex max-w-72 flex-col gap-0.5">
          <span>{summary}</span>
          {explained.fix ? <span className="text-fg-muted">{explained.fix}</span> : null}
        </span>
      }
    >
      <button
        type="button"
        aria-label={explained.fix ? `${summary} ${explained.fix}` : summary}
        className="inline-flex shrink-0 cursor-default rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Badge tone={explained.tone}>
          {guessed ? <CircleHelp aria-hidden /> : null}
          {explained.label}
        </Badge>
      </button>
    </Tooltip>
  );
}
