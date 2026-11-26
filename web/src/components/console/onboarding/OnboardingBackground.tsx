/**
 * Full-bleed backdrop for the first-run screen, in every edition: the canvas with one soft light
 * falling from the top. No texture, no streaks and no motion: the card is what moves (it rises
 * in, and dissolves on the way to the dashboard), and the backdrop only gives it a floor.
 *
 * Until RTL-371 an edition could swap this for its own (`EditionUi.OnboardingArt.Backdrop`, the
 * Cloud edition's WebGL light streaks); the dogfood read the streaks as cheap, so the core now
 * draws this one everywhere and the edition hook is no longer read.
 *
 * Rendered as a positive-z layer at the bottom of the stack (the page content sits above it via
 * `relative z-10`), so it reliably paints over the opaque body background rather than being
 * hidden behind it by a negative z-index.
 */
export function OnboardingBackground() {
  return (
    <div aria-hidden className="fixed inset-0 z-0 overflow-hidden bg-canvas">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 50% at 50% -10%, color-mix(in oklab, var(--ds-fg) 5%, transparent), transparent 70%)",
        }}
      />
    </div>
  );
}
