/**
 * Entrance motion on the Agent health page is an enhancement, never a
 * precondition for seeing the page.
 *
 * `.card-enter` and `.meter-grow` fill `backwards`/`both` so a staggered card
 * waits at `opacity: 0` (or a zero-width bar) until its animation starts. A
 * tab that loads hidden (opened in the background, or driven by automation)
 * produces no frames, so its animations never start and the page stays blank
 * until someone brings it forward. Here the page paints its final state by
 * default, and the rise-in runs only when a script, run before the content is
 * parsed, finds the document visible and marks `<html data-health-motion>`.
 * A client-side navigation keeps the mark of the load it started from: the
 * script is emitted as `PrepaintScript` (inner HTML the browser runs while
 * parsing), so React never creates a script element, and on a client render
 * it stays inert, exactly as a React-created script would.
 */

import { PrepaintScript } from "@/components/console/health/PrepaintScript";

/** Set on `<html>` when the page may animate its entrance. */
export const HEALTH_MOTION_ATTRIBUTE = "data-health-motion";

/** Marks the page subtree the gate applies to. */
export const HEALTH_PAGE_ATTRIBUTE = "data-health-page";

export const HEALTH_MOTION_SCRIPT = `(function(){try{if(document.visibilityState==="visible")document.documentElement.setAttribute("${HEALTH_MOTION_ATTRIBUTE}","on")}catch(e){}})();`;

/**
 * Without the mark, every entrance animation under the page is off, so each
 * element shows its final state (full opacity, full-width bars, drawn edges).
 */
export const HEALTH_MOTION_STYLES = `:root:not([${HEALTH_MOTION_ATTRIBUTE}]) [${HEALTH_PAGE_ATTRIBUTE}] :is(.card-enter, .meter-grow, .flow-draw, .flow-fade) { animation: none; }`;

/** The gate: rendered once, first inside the page, before anything that animates. */
export function EntranceMotion() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: HEALTH_MOTION_STYLES }} />
      <PrepaintScript name="health-motion" code={HEALTH_MOTION_SCRIPT} />
    </>
  );
}
