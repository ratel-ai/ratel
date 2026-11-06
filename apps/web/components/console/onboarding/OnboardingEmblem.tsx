import { BadgerMark } from "@ratel/design-system/badger-mark";

/**
 * The badge that heads each onboarding card. Upstream renders an animated dot-matrix orb, which
 * is third-party code this repository does not publish; the badger mark takes its place. Color
 * comes from `currentColor`, so the wrapper's text color drives the accent: `tone` swaps it to
 * green for the "key issued" success step.
 */
export function OnboardingEmblem({ tone = "coral" }: { tone?: "coral" | "mint" }) {
  return (
    <div className={tone === "mint" ? "text-green" : "text-coral"}>
      <BadgerMark className="h-12 w-auto" />
    </div>
  );
}
