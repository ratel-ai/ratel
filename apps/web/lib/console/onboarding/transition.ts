/**
 * Shared choreography for the onboarding → dashboard exit.
 *
 * The "Go to dashboard" button lives in `CreateProjectForm`, but the WebGL
 * Lightfall it needs to wind down lives in the sibling `OnboardingBackground`.
 * Rather than lift the whole first-run screen into a client shell just to thread
 * a ref between them, the button broadcasts a window event; the background
 * listens and drains its streaks. One tiny, well-named contract.
 *
 * Both exits (this one and the welcome flow's, below) share one timeline,
 * skipped entirely for reduced-motion users:
 *   0ms                  fire the event: the source stops, and the streaks
 *                        already on screen keep falling, pulled faster
 *   0 → LEAVE_DRAIN_MS   the last streaks fall out of the bottom
 *   LEAVE_VEIL_DELAY_MS  once the field is visibly empty, the veil fades in
 *   NAV_DELAY_MS         navigate under a veil that outlives this page and
 *                        lifts once the dashboard has its content, so it
 *                        fades in instead of popping (lib/arrival-veil.ts)
 *
 * The veils take their delay and duration from these constants (inline
 * styles), so the CSS in globals.css only sets the keyframes and easing.
 */
export const ONBOARDING_LEAVE_EVENT = "ratel:onboarding-leave";

/**
 * How long the streaks still on screen take to fall out once the source
 * stops. Long enough to watch the last tails leave at an easy pace: shorter,
 * and the pull needed to empty the field in time turns the fall into a blur.
 */
export const LEAVE_DRAIN_MS = 2800;
/**
 * When the veil starts fading in: the field is visibly empty by then, with only
 * faint tails left inside the bottom fade, so the veil's slow start takes them
 * with it instead of holding an empty screen for a beat.
 */
export const LEAVE_VEIL_DELAY_MS = 2400;
/** How long the veil takes to cover the scene. */
export const LEAVE_VEIL_MS = 450;
/** Click to route change: the veil has fully covered the scene. */
const LEAVE_TOTAL_MS = LEAVE_VEIL_DELAY_MS + LEAVE_VEIL_MS;

/** Delay between the click and the actual route change. */
export const NAV_DELAY_MS = LEAVE_TOTAL_MS;

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
 *   0ms            the source stops; the rail starts sliding left (1.1s)
 *   100 → 700ms    the step panel sinks and fades, following the fall
 *   0 → 2800ms     the streaks on screen fall out, pulled faster like gravity
 *   2400 → 2850ms  the field is empty; the app background fades in
 *   2850ms         the route changes; the page fades in once it is ready
 */
export const WELCOME_LEAVE_MS = LEAVE_TOTAL_MS;
