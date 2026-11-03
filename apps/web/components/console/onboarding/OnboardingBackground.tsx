/**
 * Full-bleed backdrop for the first-run screen: a fine dot-matrix texture settling into the
 * canvas, carrying the console's instrument-panel language onto the empty onboarding canvas.
 *
 * Upstream animates a WebGL field of light streaks over this texture and drains it on exit; that
 * field needs the `ogl` package and a shader this edition does not carry, so every reader gets
 * what upstream shows under reduced motion. The exit veil in `CreateProjectForm` still dissolves
 * the scene on the same timings.
 *
 * Rendered as a positive-z layer at the bottom of the stack (the page content sits above it via
 * `relative z-10`), so it reliably paints over the opaque body background rather than being
 * hidden behind it by a negative z-index.
 */
export function OnboardingBackground() {
  return (
    <div aria-hidden className="fixed inset-0 z-0 overflow-hidden bg-canvas">
      {/* Fine tiled dot field for texture. */}
      <div className="absolute inset-0 dot-field opacity-80" />

      {/* Settle the field back into the canvas at the bottom. */}
      <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-b from-transparent to-canvas" />
    </div>
  );
}
