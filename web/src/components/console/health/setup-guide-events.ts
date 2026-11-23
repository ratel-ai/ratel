import type { SetupKey } from "@/lib/readings/trace-signals/setup-facts";

/**
 * A section asks the setup card to open one guide: a window event, so the
 * card and the sections stay independent (the card may be dismissed, or not
 * on the page at all on runs stored before setup facts).
 */
export const SETUP_GUIDE_EVENT = "ratel:open-setup-guide";

export interface SetupGuideRequest {
  key: SetupKey;
}

export function openSetupGuide(key: SetupKey): void {
  window.dispatchEvent(new CustomEvent<SetupGuideRequest>(SETUP_GUIDE_EVENT, { detail: { key } }));
}

/** The key a guide event names, or null for anything else. */
export function requestedGuide(event: Event): SetupKey | null {
  const detail = (event as CustomEvent<Partial<SetupGuideRequest>>).detail;
  return detail && typeof detail.key === "string" ? (detail.key as SetupKey) : null;
}
