/**
 * A page state asks the importer to open its source picker: a window event,
 * so the state blocks and the importer stay independent (the importer is
 * mounted once per page, as the card, the header button or the history list).
 */
export const OPEN_IMPORT_EVENT = "ratel:open-health-import";

export function openHealthImport(): void {
  window.dispatchEvent(new Event(OPEN_IMPORT_EVENT));
}
