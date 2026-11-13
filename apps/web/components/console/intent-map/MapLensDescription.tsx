"use client";

import { useSearchParams } from "next/navigation";
import { LENS_DESCRIPTIONS } from "@/components/console/intent-map/lens-descriptions";

/** The sentence for the lens in the URL (`?view=`), so it changes with the lens. */
export function MapLensDescription() {
  const view = useSearchParams().get("view");
  return (
    <>
      {view === "asks" || view === "flow" || view === "tools"
        ? LENS_DESCRIPTIONS[view]
        : LENS_DESCRIPTIONS.map}
    </>
  );
}
