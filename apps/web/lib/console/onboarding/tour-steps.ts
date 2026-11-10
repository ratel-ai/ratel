/**
 * What the guided tour says, and what it points at.
 *
 * Kept out of the component so the copy can be read, reviewed, and tested
 * without a DOM. This is the first thing a new account ever reads about the
 * product, and it is the part most likely to go stale as surfaces move.
 *
 * The tour walks the rail, one item per step, in rail order: what each place
 * is for, so the reader knows where to look before they need it. It names the
 * few places a new reader needs, not every page.
 *
 * Each step names a `data-tour` attribute rather than a CSS class or a
 * structural selector. A class is a styling decision somebody will change
 * without knowing the tour depends on it; an explicit attribute is a contract
 * that shows up in a grep. The rail derives each anchor from its item's id
 * (`nav-<id>`, see `components/shell/Sidebar.tsx`), so a renamed item drops
 * its step rather than spotlighting the wrong thing. Steps whose target is not
 * on the page are dropped at runtime (see `resolveTourSteps`), so a rail
 * without Quality, or a project that is not the demo, gets a shorter tour
 * instead of a spotlight on nothing.
 *
 * Agent health's anchor, `data-tour="agent-health"`, is rendered by the rail
 * only while the `cloud-agent-health` flag is on, so the flag gates the step
 * with no second check here; until the rail renders it, the step is simply
 * dropped. Agent health is a top-level project entry right under Overview, so
 * its row is on screen wherever the tour runs (a folded entry would be
 * skipped, see `isSpotlightable`).
 */

/** Where the card prefers to sit. Flipped at runtime when it would overflow. */
export type TourPlacement = "right" | "bottom" | "left" | "top";

export interface TourStep {
  /** What analytics records as `step_id`, so it stays as first shipped. */
  id: string;
  /** Value of the `data-tour` attribute on the element to spotlight. */
  target: string;
  title: string;
  body: string;
  placement: TourPlacement;
  /** Present only when the step describes the demo project's own data. */
  demoOnly?: boolean;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "v2-overview",
    target: "nav-overview",
    title: "Overview: how this project is doing",
    body: "Runs, first try, latency and cost at a glance, and the few things that need you right now.",
    placement: "right",
  },
  {
    id: "agent-health",
    target: "agent-health",
    title: "Agent health: what your agent gets wrong",
    body: "Right under Overview. It reads your agent's own traces and names what trips it up: detours, tools that crowd out the right one, and what in your catalog to change.",
    placement: "right",
  },
  {
    id: "v2-traces",
    target: "nav-traces",
    title: "Traces: what happened in a run",
    body: "Every run reads like a conversation: the ask, each step, the tools it called and what it cost.",
    placement: "right",
  },
  {
    id: "v2-catalog",
    target: "nav-catalog",
    title: "Catalog: what your agent can use",
    body: "Your tools and skills, the one description you edit, and a search box to test how they are found.",
    placement: "right",
  },
  {
    id: "v2-quality",
    target: "nav-quality",
    title: "Quality: was the right tool picked",
    body: "Searches that missed, the rewrites that would fix them, and the experiments behind both.",
    placement: "right",
  },
  {
    id: "demo-notice",
    target: "demo-notice",
    title: "This project is not yours",
    body: "We seeded it so the tour had something to point at. Nothing in it is real, nothing you do to it matters, and you can delete it the moment it stops being useful.",
    placement: "bottom",
    demoOnly: true,
  },
  {
    id: "command-palette",
    target: "command-palette",
    title: "⌘K reaches every page",
    body: "Search by name or by what you are trying to do: try “spans”, “credits”, or “API key”.",
    placement: "right",
  },
];

/**
 * The steps that can actually run: those whose target is on the page, in
 * definition order. A tour that spotlights a missing element renders a hole in
 * the middle of the screen and explains something the reader cannot see, which
 * is worse than not offering that step at all.
 */
export function resolveTourSteps(
  steps: readonly TourStep[],
  hasTarget: (target: string) => boolean,
): TourStep[] {
  return steps.filter((step) => hasTarget(step.target));
}

/**
 * Whether an element can carry a spotlight: it has a box, and it is not folded
 * away (a folded rail group keeps its links in the DOM with a real height,
 * clipped to nothing, under `inert`).
 */
export function isSpotlightable(
  box: { width: number; height: number },
  insideHiddenSubtree: boolean,
): boolean {
  return !insideHiddenSubtree && box.width > 0 && box.height > 0;
}
