/**
 * The page menu asks the edition's share dialog to open: a window event, so the menu and the
 * dialog stay independent (the dialog is the edition's, `EditionUi.HealthShare`, mounted once on
 * the page). The edition listens for the same name.
 */
export const OPEN_SHARE_EVENT = "ratel:open-health-share";

export function openHealthShare(): void {
  window.dispatchEvent(new Event(OPEN_SHARE_EVENT));
}
