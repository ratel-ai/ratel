/**
 * Shared choreography for the onboarding → dashboard exit.
 *
 * The "Go to dashboard" button lives in `CreateProjectForm`, but the WebGL
 * Lightfall it needs to wind down lives in the sibling `OnboardingBackground`.
 * Rather than lift the whole first-run screen into a client shell just to thread
 * a ref between them, the button broadcasts a window event; the background
 * listens and drains its streaks. One tiny, well-named contract.
 *
 * Timeline after the click (skipped entirely for reduced-motion users):
 *   0ms            fire the event → the streaks start draining (a curtain cutoff
 *                  sweeps top→bottom; the fall accelerates and pours out the bottom)
 *   0 → ~680ms     the field drains to leave only the static dot-field, while the
 *                  draining streaks magnify toward the viewer (both in-shader)
 *   ~720 → ~1060ms a base veil fades in over the dot-field → reveals the dashboard
 *   NAV_DELAY_MS   navigate — landing on the dashboard's staggered pop-in
 *
 * Keep these in sync with the shader `DRAIN_MS` / `uDrain` / `uApproach` wind-down
 * in lightfall.tsx and the `.onboarding-settle` / `.onboarding-dissolve` timings
 * in globals.css.
 */
export const ONBOARDING_LEAVE_EVENT = "ratel:onboarding-leave";

/** Delay between the click and the actual route change. */
export const NAV_DELAY_MS = 1100;

/**
 * The welcome flow's "a step's work just landed" without a navigation (a
 * project created in place): the waterfall rushes for a moment. The level
 * change between steps surges on its own.
 */
export const WELCOME_SURGE_EVENT = "ratel:welcome-surge";

/**
 * The welcome flow's exit, start to route change. Kayra's brief: the rail
 * slides away left, nothing new falls, the last streaks drop out, and the page
 * opens. Timeline (globals.css `.welcome-*-leave`, Lightfall `drain`):
 *   0ms           the source stops; the rail starts sliding left (1.1s)
 *   100 → 700ms   the step panel sinks and fades, following the fall
 *   0 → 1800ms    the streaks on screen fall out, pulled faster like gravity
 *   1450 → 1800ms the app background fades in as the last tails leave
 *   1800ms        the route changes
 */
export const WELCOME_LEAVE_MS = 1800;
