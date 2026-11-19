"use client";

import { cn } from "@ratel/design-system/cn";
import { X } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import { SetupGuidePanel } from "@/components/console/health/SetupGuidePanel";
import {
  initialSetupCardState,
  type SetupCardModel,
  type SetupPill,
  setupCardReducer,
} from "@/components/console/health/setup-card-model";
import { requestedGuide, SETUP_GUIDE_EVENT } from "@/components/console/health/setup-guide-events";
import type { SetupStack } from "@/components/console/health/setup-guides";
import { track } from "@/lib/platform/track-client";
import type { SetupKey } from "@/lib/readings/trace-signals/setup-facts";
import type { CaptureLevel } from "@/lib/readings/trace-signals/view";

export interface SetupCardProps {
  projectId: string;
  model: SetupCardModel;
  /** For the "opened a guide" event, which the capture nudge used before this card. */
  captureLevel: CaptureLevel;
}

/**
 * What to turn on for a better page, as one row: a dot, "4 settings
 * missing", one chip per missing data point and Dismiss. A chip opens one
 * line of what it adds and the snippet for the common stacks, one at a time.
 * Shown on every page load while anything is missing; Dismiss hides it for
 * this page view only (React state, nothing stored).
 */
export function SetupCard({ projectId, model, captureLevel }: SetupCardProps) {
  const [state, dispatch] = useReducer(setupCardReducer, undefined, initialSetupCardState);
  const [stack, setStack] = useState<SetupStack | null>(null);
  const [tracked, setTracked] = useState(false);
  const pills = model.groups.flatMap((group) => group.pills);
  const current = pills.find((pill) => pill.key === state.open) ?? null;
  // Keep the last guide drawn while its panel folds away, so it never empties mid-close.
  const [shown, setShown] = useState<SetupPill | null>(current);
  if (current && current !== shown) setShown(current);
  const ref = useRef<HTMLElement>(null);
  const keys = pills.map((pill) => pill.key).join(",");

  // A section's "how to send" button opens its guide here, even after Dismiss.
  useEffect(() => {
    const listener = (event: Event) => {
      const key = requestedGuide(event);
      if (!key || !keys.split(",").includes(key)) return;
      dispatch({ type: "show", key });
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      requestAnimationFrame(() =>
        ref.current?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" }),
      );
    };
    window.addEventListener(SETUP_GUIDE_EVENT, listener);
    return () => window.removeEventListener(SETUP_GUIDE_EVENT, listener);
  }, [keys]);

  if (state.dismissed) return null;

  const toggle = (key: SetupKey) => {
    dispatch({ type: "toggle", key });
    if (!tracked) {
      setTracked(true);
      track("content_capture_enabled_from_nudge", {
        project_id: projectId,
        capture_level: captureLevel,
        unlock_count: model.missing,
      });
    }
  };

  return (
    <section
      ref={ref}
      aria-labelledby="setup-card-title"
      data-setup-card="true"
      className="card-enter scroll-mt-24 rounded-2xl border border-forest-300 bg-forest-600/40 px-4 py-3 sm:px-5"
      style={{ animationDelay: "60ms" }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-ctx-tools" />
        <h2 id="setup-card-title" className="text-[13px] font-semibold text-cream">
          {model.title}
        </h2>
        {/* On a phone the chips wrap under the title, and Dismiss stays beside it. */}
        <div className="order-last flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 sm:order-none sm:w-auto">
          {model.groups.map((group) => (
            <ul
              key={group.source}
              data-setup-group={group.source}
              className="flex flex-wrap items-center gap-1.5"
            >
              {group.title && (
                <li className="font-mono text-[10px] uppercase tracking-[0.1em] text-warm-muted">
                  {group.title}
                </li>
              )}
              {group.pills.map((pill) => (
                <li key={pill.key}>
                  <Chip
                    pill={pill}
                    open={state.open === pill.key}
                    onToggle={() => toggle(pill.key)}
                  />
                </li>
              ))}
            </ul>
          ))}
        </div>
        <button
          type="button"
          onClick={() => dispatch({ type: "dismiss" })}
          data-setup-dismiss="true"
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-warm-muted outline-none transition-colors hover:text-cream focus-visible:ring-2 focus-visible:ring-coral/60"
        >
          <X className="size-3.5" aria-hidden />
          Dismiss
        </button>
      </div>
      {model.alert && (
        <p data-setup-alert="true" className="mt-2 text-[12px] leading-5 text-coral">
          {model.alert}
        </p>
      )}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
          current ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div
          id="setup-guide"
          className="min-h-0 min-w-0 overflow-hidden"
          inert={!current || undefined}
        >
          {shown && (
            <div className="pt-3">
              <SetupGuidePanel
                pill={shown}
                stack={stack}
                onStack={setStack}
                received={model.received}
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Chip({ pill, open, onToggle }: { pill: SetupPill; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls="setup-guide"
      aria-label={`${pill.label}: ${pill.statusText}`}
      onClick={onToggle}
      data-setup-pill={pill.key}
      data-setup-tone={pill.tone}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-coral/60",
        open
          ? "border-cream bg-cream text-ink"
          : "border-forest-300 bg-base-deep/40 text-cream-dim hover:border-warm-muted/60 hover:text-cream",
      )}
    >
      {pill.label}
      {pill.chipNote && (
        <span className={open ? "text-ink/60" : "text-warm-muted"}>{pill.chipNote}</span>
      )}
    </button>
  );
}
