/**
 * Full-bleed backdrop for the first-run screen when the edition supplies none
 * (`EditionUi.OnboardingArt.Backdrop`): the canvas with one soft light falling from the top. Kept
 * quiet so the backdrop never competes with the call to action; the card is what moves (it rises
 * in, and dissolves on the way to the dashboard).
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
