"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { PeekLink } from "@ratel/design-system/panel";
import { Callout } from "@ratel/design-system/states";
import { useState, useSyncExternalStore } from "react";
import {
  isNudgeSnoozed,
  readNudgeSnooze,
  snoozeNudge,
  subscribeToNudgeSnooze,
} from "@/components/console/health/capture-nudge-model";
import type { SetupCardModel, SetupPill } from "@/components/console/health/setup-card-model";
import {
  type CaptureNudgeInput,
  nudgeShown,
  nudgeTitle,
} from "@/components/console/health/v2/setup-nudge";
import { CAPTURE_GUIDE, setupPeek } from "@/components/console/health/v2/setup-peek";

/**
 * What to turn on for a better page, as the page's one Callout: how many
 * settings are missing and one chip per data point, each opening its guide
 * in a Panel. Dismiss hides it for this page view only, as before. On a
 * reading stored before setup facts, the older nudge: what content capture
 * (or the OpenTelemetry options) would add, "Not now" for 30 days.
 */

/** The one thing the data shows is wrong: runs that hold several users' calls. */
const MIXED_RUNS_LINE =
  "Calls from different users land in the same run, so turn shapes, tasks and the issues read per run are hidden until turn ids arrive.";

const CHIP =
  "inline-flex h-6 items-center gap-1.5 rounded-md border border-line-strong bg-app px-2 text-xs text-fg outline-none transition-colors duration-120 hover:border-line-active hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus";

const DOT: Readonly<Record<SetupPill["tone"], string>> = {
  green: "bg-success",
  amber: "bg-warning",
  coral: "bg-danger",
};

export function SetupCallout({
  projectId,
  card,
  nudge,
}: {
  projectId: string;
  card: SetupCardModel | null;
  nudge: CaptureNudgeInput | null;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (card) {
    if (dismissed) return null;
    return (
      <Callout
        tone="warning"
        title={card.title}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDismissed(true)}
            data-setup-dismiss=""
          >
            Dismiss
          </Button>
        }
      >
        <div className="flex flex-col gap-2 pt-1" data-setup-card={card.missing}>
          {card.alert ? <p data-setup-alert="">{MIXED_RUNS_LINE}</p> : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {card.groups.map((group) => (
              <ul
                key={group.source}
                className="flex flex-wrap items-center gap-1.5"
                data-setup-group={group.source}
              >
                {group.title ? <li className="text-xs text-fg-subtle">{group.title}</li> : null}
                {group.pills.map((pill) => (
                  <li key={pill.key}>
                    <PeekLink peek={setupPeek(pill.key)} className={CHIP}>
                      <span
                        aria-hidden
                        className={cn("size-1.5 shrink-0 rounded-full", DOT[pill.tone])}
                      />
                      <span data-setup-pill={pill.key}>{pill.label}</span>
                      <span className="text-fg-subtle">
                        {pill.status === "off" ? "Not sent" : `Partly sent, ${pill.chipNote ?? ""}`}
                      </span>
                    </PeekLink>
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </div>
      </Callout>
    );
  }
  return nudge ? <Nudge projectId={projectId} nudge={nudge} /> : null;
}

function Nudge({ projectId, nudge }: { projectId: string; nudge: CaptureNudgeInput }) {
  const [dismissed, setDismissed] = useState(false);
  // Server and first client render agree on "not snoozed"; a snoozed browser hides it right after.
  const snoozed = useSyncExternalStore(
    subscribeToNudgeSnooze,
    () => isNudgeSnoozed(readNudgeSnooze(projectId), Date.now()),
    () => false,
  );
  if (!nudgeShown(nudge) || dismissed || snoozed) return null;
  return (
    <Callout
      title={nudgeTitle(nudge)}
      action={
        <span className="flex items-center gap-2">
          <PeekLink peek={setupPeek(CAPTURE_GUIDE)} className={CHIP}>
            Show me the change
          </PeekLink>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              snoozeNudge(projectId, Date.now());
              setDismissed(true);
            }}
          >
            Not now
          </Button>
        </span>
      }
    >
      <p data-capture-nudge={nudge.unlocks.length}>
        Adds: {nudge.unlocks.map((unlock) => unlock.label).join(", ")}.
      </p>
    </Callout>
  );
}
