/**
 * A few lines of script that must run while the page is parsed, before its
 * first paint: in the server's HTML, the browser runs it like any inline
 * script. It is written as the inner HTML of a hidden element rather than as
 * a `<script>` element, so React never creates a script itself: rendering one
 * on the client (a soft navigation) warns, and it would never run anyway.
 * Hydration keeps the server's inner HTML as it is. On a soft navigation the
 * browser leaves a script set as inner HTML inert, so the component using
 * this must reach the same result before its first client paint on its own
 * (`useSyncExternalStore` for what it renders, a layout effect for any mark
 * it keeps on `<html>`).
 *
 * `code` must be a constant written in this codebase, never anything a user
 * or a request can shape.
 */
export interface PrepaintScriptProps {
  /** Names the script for tests and inspection. */
  name: string;
  code: string;
}

export function PrepaintScript({ name, code }: PrepaintScriptProps) {
  return (
    <div
      hidden
      data-prepaint={name}
      dangerouslySetInnerHTML={{ __html: `<script>${code}</script>` }}
    />
  );
}
