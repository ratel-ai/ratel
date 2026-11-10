"use client";

import { Button } from "@ratel/design-system/button";
import { cn } from "@ratel/design-system/cn";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  cardPosition,
  type Rect,
  SPOTLIGHT_PADDING,
  spotlightRect,
} from "@/lib/console/onboarding/tour-geometry";
import type { OnboardingTourStatus } from "@/lib/console/onboarding/tour-state";
import {
  isSpotlightable,
  resolveTourSteps,
  TOUR_STEPS,
  type TourStep,
} from "@/lib/console/onboarding/tour-steps";
import { track } from "@/lib/platform/track-client";

/**
 * The guided tour: everything dims except one area, and a card explains it.
 *
 * The dimming is a single SVG rectangle with a hole punched in it by a mask,
 * not four positioned divs. One shape means the hole can have rounded corners
 * and can animate from step to step as one movement, and it means there is no
 * chance of a one-pixel seam between panels on a fractional-scale display.
 *
 * The overlay swallows pointer events on purpose. A tour where you can click
 * the thing being described will have people navigating away mid-explanation
 * and finding the tour still running over a page it no longer matches, so the
 * page is inert until the tour ends, which is one step away at all times.
 *
 * It arrives without a jolt. It waits for the page to settle (the welcome
 * flow's exit lands here, then the page's own content rises in), then the dim
 * fades in while the spotlight settles onto the first target from a little
 * wider, and the card follows a beat later. Leaving runs the same in reverse.
 * (A spotlight closing in from the whole screen read as a wipe, so it does not.)
 * The spotlight is tweened in JavaScript: CSS does not transition SVG geometry
 * attributes, so an attribute "transition" only ever jumped.
 *
 * Accessibility, deliberately: the card is a modal dialog with focus moved into
 * it and trapped there, Escape ends the tour, and the arrow keys move between
 * steps. `prefers-reduced-motion` turns off the fade and the spotlight's
 * travel, because the whole effect is a large moving shape.
 */

export interface GuidedTourProps {
  /** False when the user has already finished or skipped it. */
  offer: boolean;
  /** Included so demo-only steps are dropped for a real project. */
  isDemoProject: boolean;
  /** Analytics label for where the tour ran. */
  surface: string;
  /** Persists the outcome. Resolves once the write lands. */
  onFinish: (
    status: OnboardingTourStatus,
    detail: { lastStepId: string; stepsViewed: number },
  ) => Promise<void> | void;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])';

/** How long the page gets to settle before the tour asks for attention. */
const SETTLE_MS = 700;
/** The spotlight's travel between rects, and the fade in. */
const TRAVEL_MS = 520;
/** The fade out: quicker than the way in (DESIGN.md, Motion). */
const LEAVE_MS = 260;

type Phase = "waiting" | "entering" | "open" | "leaving";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** How much wider the spotlight is as it fades in and out. */
const SETTLE_INSET = 28;

function widened(rect: Rect): Rect {
  return {
    top: rect.top - SETTLE_INSET,
    left: rect.left - SETTLE_INSET,
    width: rect.width + SETTLE_INSET * 2,
    height: rect.height + SETTLE_INSET * 2,
  };
}

/**
 * The rect on screen, eased toward `goal` frame by frame (ease-out cubic).
 * Starts from `from` the first time, then from wherever it currently is, so a
 * step change mid-travel bends smoothly instead of restarting.
 */
function useTweenedRect(goal: Rect | null, from: () => Rect, duration: number): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  const current = useRef<Rect | null>(null);
  const goalKey = goal ? `${goal.top}|${goal.left}|${goal.width}|${goal.height}` : "";

  useEffect(() => {
    if (!goal) return;
    const start = current.current ?? from();
    const reduce = prefersReducedMotion();
    let frame = 0;
    const began = performance.now();
    const tick = (now: number) => {
      const p = reduce ? 1 : Math.min(1, (now - began) / duration);
      const e = 1 - (1 - p) ** 3;
      const next = {
        top: start.top + (goal.top - start.top) * e,
        left: start.left + (goal.left - start.left) * e,
        width: start.width + (goal.width - start.width) * e,
        height: start.height + (goal.height - start.height) * e,
      };
      current.current = next;
      setRect(next);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // The goal's numbers are the dependency; the object is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalKey, duration]);

  return rect;
}

export function GuidedTour({ offer, isDemoProject, surface, onFinish }: GuidedTourProps) {
  const [steps, setSteps] = useState<TourStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const [target, setTarget] = useState<Rect | null>(null);
  const [cardSize, setCardSize] = useState({ width: 340, height: 200 });
  const [phase, setPhase] = useState<Phase>("waiting");
  const cardRef = useRef<HTMLDivElement>(null);
  const finishing = useRef(false);

  // Resolve the runnable steps once the page has settled.
  //
  // Not at mount: the tour usually starts on the page someone has just
  // arrived at, while its content is still rising in. Measuring then both
  // risks a target that is still moving and lands a full-screen dim on top of
  // an entrance animation, which reads as a flicker. So: a short wait, the
  // fonts, then two frames in which the targets have not moved.
  useEffect(() => {
    if (!offer) return;
    let cancelled = false;
    let frame = 0;
    const candidates = TOUR_STEPS.filter((step) => !step.demoOnly || isDemoProject);
    const measure = () =>
      candidates
        .map((step) =>
          document.querySelector(`[data-tour="${step.target}"]`)?.getBoundingClientRect(),
        )
        .map((box) => (box ? `${box.top}|${box.left}|${box.width}|${box.height}` : "-"))
        .join(",");

    const resolve = () => {
      const runnable = resolveTourSteps(candidates, (name) => {
        const element = document.querySelector(`[data-tour="${name}"]`);
        return (
          element !== null &&
          isSpotlightable(
            element.getBoundingClientRect(),
            element.closest('[aria-hidden="true"], [inert]') !== null,
          )
        );
      });
      // One step is not a tour; it is an unexplained hole in the screen.
      if (runnable.length < 2) return;
      setSteps(runnable);
      track("onboarding_tour_started", {
        step_count: runnable.length,
        surface,
      });
    };

    const timer = window.setTimeout(() => {
      void (document.fonts?.ready ?? Promise.resolve()).then(() => {
        let last = "";
        let stable = 0;
        let tries = 0;
        const check = () => {
          if (cancelled) return;
          const now = measure();
          stable = now === last ? stable + 1 : 0;
          last = now;
          if (stable >= 2 || ++tries > 60) resolve();
          else frame = requestAnimationFrame(check);
        };
        frame = requestAnimationFrame(check);
      });
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [offer, isDemoProject, surface]);

  const step = steps?.[index];

  // Track where the target actually is.
  //
  // A ResizeObserver rather than a one-off measurement: it delivers the first
  // reading as soon as it starts observing AND every later one, which covers
  // the case a plain measure-on-mount misses: a group revealing its sub-pages
  // beneath the very row being spotlit, growing it after the spotlight was
  // drawn. Scroll and resize are separate because neither changes the
  // element's own box.
  useEffect(() => {
    if (!step) return;
    const element = document.querySelector(`[data-tour="${step.target}"]`);
    if (!element) return;
    const remeasure = () => {
      const box = element.getBoundingClientRect();
      setTarget({
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
      });
    };
    const observer = new ResizeObserver(remeasure);
    observer.observe(element);
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
    };
  }, [step]);

  // First paint with the dim at zero and the spotlight a little wide, then on the
  // next frame let both travel in: the transition needs a starting state.
  const ready = !!steps && !!step && !!target;
  useEffect(() => {
    if (!ready || phase !== "waiting") return;
    const frame = requestAnimationFrame(() => setPhase("entering"));
    return () => cancelAnimationFrame(frame);
  }, [ready, phase]);
  useEffect(() => {
    if (phase !== "entering") return;
    const timer = window.setTimeout(() => setPhase("open"), TRAVEL_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useLayoutEffect(() => {
    const box = cardRef.current?.getBoundingClientRect();
    if (box) setCardSize({ width: box.width, height: box.height });
  }, [step, ready]);

  const finish = useCallback(
    (status: OnboardingTourStatus) => {
      if (finishing.current) return;
      finishing.current = true;
      const lastStepId = steps?.[index]?.id ?? "unknown";
      const stepsViewed = index + 1;
      // Leave the way it came: the dim fades and the spotlight opens back up,
      // then the parent unmounts it.
      setPhase("leaving");
      window.setTimeout(
        () => void onFinish(status, { lastStepId, stepsViewed }),
        prefersReducedMotion() ? 0 : LEAVE_MS,
      );
    },
    [onFinish, steps, index],
  );

  useEffect(() => {
    if (!steps || !step) return;
    track("onboarding_tour_step_viewed", {
      step_id: step.id,
      step_index: index,
      step_count: steps.length,
    });
  }, [steps, step, index]);

  // Move focus into the card on open, and give it back on close, so a keyboard
  // reader is not left tabbing an inert page behind the overlay.
  useEffect(() => {
    if (!ready) return;
    const previous = document.activeElement as HTMLElement | null;
    cardRef.current?.focus({ preventScroll: true });
    return () => previous?.focus?.();
  }, [ready]);

  useEffect(() => {
    if (!steps) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        finish("skipped");
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setIndex((current) => (current + 1 < (steps?.length ?? 0) ? current + 1 : current));
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [steps, finish]);

  const viewport =
    typeof window === "undefined"
      ? { width: 0, height: 0 }
      : { width: window.innerWidth, height: window.innerHeight };
  const lit = ready ? spotlightRect(target, viewport) : null;
  const goal = !lit ? null : phase === "waiting" || phase === "leaving" ? widened(lit) : lit;
  const hole = useTweenedRect(
    goal,
    () => (lit ? widened(lit) : { top: 0, left: 0, width: 0, height: 0 }),
    phase === "leaving" ? LEAVE_MS : TRAVEL_MS,
  );

  if (!steps || !step || !target || !hole) return null;

  const finalHole = spotlightRect(target, viewport);
  const card = cardPosition(finalHole, cardSize, viewport, step.placement);
  const last = index === steps.length - 1;
  const shown = phase === "entering" || phase === "open";
  const radius = 12;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-tour transition-opacity ease-enter motion-reduce:transition-none",
        shown ? "opacity-100" : "opacity-0",
      )}
      style={{ transitionDuration: phase === "leaving" ? `${LEAVE_MS}ms` : `${TRAVEL_MS}ms` }}
      // The page is inert while the tour runs; every control the reader needs
      // is inside the card.
      onWheel={(event) => event.preventDefault()}
    >
      <svg className="pointer-events-auto absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <mask id="guided-tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            <rect
              x={hole.left}
              y={hole.top}
              width={hole.width}
              height={hole.height}
              rx={radius}
              fill="black"
            />
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="var(--ds-scrim)"
          mask="url(#guided-tour-mask)"
        />
      </svg>

      {/* The lit ring. Separate from the mask so it can carry a colour without
          the mask having to become a gradient. */}
      <div
        aria-hidden
        style={{
          top: hole.top,
          left: hole.left,
          width: hole.width,
          height: hole.height,
          borderRadius: radius,
        }}
        className={cn(
          "pointer-events-none absolute ring-1 ring-accent-mark/60 transition-opacity duration-200",
          phase === "open" ? "opacity-100" : "opacity-0",
        )}
      />

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="guided-tour-title"
        aria-describedby="guided-tour-body"
        tabIndex={-1}
        style={{ top: card.top, left: card.left }}
        className={cn(
          "pointer-events-auto absolute w-[min(21rem,calc(100vw-2rem))] rounded-xl border border-line bg-overlay p-4 text-fg shadow-dialog outline-none",
          // Rises in a beat after the dim; between steps it glides with the spotlight.
          "transition-[top,left,opacity,translate] duration-500 ease-enter motion-reduce:transition-none",
          phase === "open" ? "translate-y-0 opacity-100" : "translate-y-1.5 opacity-0",
          phase === "leaving" && "duration-200",
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-fg-subtle tabular-nums">
            Step {index + 1} of {steps.length}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="-mr-1.5 h-6 px-1.5 text-xs"
            onClick={() => finish("skipped")}
          >
            Skip tour
          </Button>
        </div>

        <h2 id="guided-tour-title" className="mt-2 text-sm font-semibold text-fg">
          {step.title}
        </h2>
        <p id="guided-tour-body" className="mt-1.5 text-sm text-pretty text-fg-muted">
          {step.body}
        </p>

        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex gap-1.5" aria-hidden>
            {steps.map((dot, dotIndex) => (
              <span
                key={dot.id}
                className={cn(
                  "size-1.5 rounded-full transition-colors duration-200",
                  dotIndex === index ? "bg-accent-mark" : "bg-line-strong",
                )}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {index > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setIndex((current) => current - 1)}
              >
                Back
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => (last ? finish("completed") : setIndex((current) => current + 1))}
            >
              {last ? "Finish tour" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export { SPOTLIGHT_PADDING };
