/** Where a reader asked for Self-corrections: in Insights, or under Agent health. */
export type SelfCorrectionsAddress = "top-level" | "health";

type Query = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * Where this visit belongs when it is not here: in Insights with `focusedConsole` on, under Agent
 * health with it off. The whole query moves along. Null when the reader is in the right place.
 */
export function selfCorrectionsRedirect(
  address: SelfCorrectionsAddress,
  focusedConsole: boolean,
  projectId: string,
  query: Query = {},
): string | null {
  const target: SelfCorrectionsAddress = focusedConsole ? "top-level" : "health";
  if (address === target) return null;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) search.append(key, item);
    }
  }
  const path = `/project/${encodeURIComponent(projectId)}${
    target === "health" ? "/health" : ""
  }/self-corrections`;
  return search.size > 0 ? `${path}?${search}` : path;
}
