/**
 * Full-bleed backdrop for the first-run screen, in every edition: a quiet canvas with a soft
 * light falling from the top, the console's 8 px dot grid showing only inside that light, and the
 * edges settling into shadow. No streaks and no motion: the card is what moves (it rises in, and
 * dissolves on the way to the dashboard), and the backdrop only gives it a floor.
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
      {/* The light: a wide, low-contrast pool from the top edge. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(70% 55% at 50% -8%, color-mix(in oklab, var(--ds-fg) 7%, transparent), transparent 72%)",
        }}
      />
      {/* The dot grid, lit only where the light falls. */}
      <div
        className="absolute inset-0 dot-grid opacity-70"
        style={{
          maskImage: "radial-gradient(55% 45% at 50% 0%, #000 10%, transparent 80%)",
          WebkitMaskImage: "radial-gradient(55% 45% at 50% 0%, #000 10%, transparent 80%)",
        }}
      />
      {/* A faint coral warmth under the card, the one accent on the page. */}
      <div
        className="absolute inset-x-0 bottom-[-20%] h-[60%]"
        style={{
          background:
            "radial-gradient(45% 50% at 50% 100%, color-mix(in oklab, var(--ds-accent-mark) 7%, transparent), transparent 70%)",
        }}
      />
      {/* Edges settle into shadow, so the card sits in the middle of the light. */}
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(120% 90% at 50% 40%, transparent 55%, rgb(0 0 0 / 0.45))",
        }}
      />
    </div>
  );
}
