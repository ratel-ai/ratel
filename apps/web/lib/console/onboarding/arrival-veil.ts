/**
 * The second half of the onboarding exit: arriving on the dashboard.
 *
 * The exit veil belongs to the page being left, so it goes the moment the route
 * changes, and the dashboard used to appear all at once behind it (shell
 * skeleton, then the page skeleton, then the content). Instead, at the route
 * change a veil of the same colour goes straight onto `document.body`, outside
 * React, so it outlives the page that made it. It waits for the dashboard to
 * have its content and then lifts slowly while the page area settles up into
 * place: the dashboard fades in out of the background instead of popping.
 * Only the motion path calls this; reduced motion just navigates.
 */

/** How long the veil takes to lift once the page is ready (globals.css `.arrival-veil-lift`). */
export const ARRIVAL_LIFT_MS = 700;
/**
 * The longest the veil holds for content. A slow page lifts anyway and shows
 * its skeleton, so a cold start never sits on a blank screen.
 */
export const ARRIVAL_MAX_WAIT_MS = 1500;
const POLL_MS = 50;

export interface ArrivalState {
  /** Where the browser is now. */
  pathname: string;
  /** Where we are going. */
  target: string;
  /** The signed-in shell's page area is mounted (not the shell skeleton). */
  hasMain: boolean;
  /** Something in the page area is still a loading skeleton. */
  busy: boolean;
  /** Milliseconds since the navigation started. */
  waited: number;
}

/** Lift once the dashboard has its content, or once we have waited long enough. */
export function shouldLift(state: ArrivalState): boolean {
  if (state.waited >= ARRIVAL_MAX_WAIT_MS) return true;
  return state.pathname === state.target && state.hasMain && !state.busy;
}

/**
 * Navigate to `href` under a veil that lifts once the page is ready. The page
 * leaving must already be covered (its own exit veil), so the swap is unseen.
 */
export function navigateUnderVeil(href: string, navigate: (href: string) => void): void {
  const veil = document.createElement("div");
  veil.setAttribute("aria-hidden", "true");
  veil.className = "arrival-veil";
  document.body.appendChild(veil);

  const target = new URL(href, window.location.href).pathname;
  const start = performance.now();
  navigate(href);

  // A timer rather than animation frames: frames stop in a background tab,
  // and the veil must never be left standing.
  const timer = window.setInterval(() => {
    const main = document.getElementById("main-content");
    const ready = shouldLift({
      pathname: window.location.pathname,
      target,
      hasMain: main !== null,
      busy: main?.querySelector('[aria-busy="true"]') != null,
      waited: performance.now() - start,
    });
    if (!ready) return;
    window.clearInterval(timer);
    // Two frames so the content has painted before it starts to show.
    requestAnimationFrame(() => requestAnimationFrame(() => lift(veil)));
    // If frames are paused (hidden tab), lift without waiting for them.
    window.setTimeout(() => lift(veil), 100);
  }, POLL_MS);
}

/** How far the page area rises as it comes in, in pixels. */
const ARRIVAL_RISE_PX = 10;

function lift(veil: HTMLElement): void {
  if (veil.classList.contains("arrival-veil-lift")) return;
  veil.classList.add("arrival-veil-lift");
  // The page area settles up into place as it shows, so it arrives rather than
  // just un-dims. A Web Animation, not a class: React owns that element's
  // classes, and this leaves nothing behind when it ends.
  document
    .getElementById("main-content")
    ?.animate?.([{ transform: `translateY(${ARRIVAL_RISE_PX}px)` }, { transform: "none" }], {
      duration: ARRIVAL_LIFT_MS + 150,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    });
  const remove = () => veil.remove();
  veil.addEventListener("animationend", remove, { once: true });
  window.setTimeout(remove, ARRIVAL_LIFT_MS + 200);
}
