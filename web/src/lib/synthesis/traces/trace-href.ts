export function buildTraceHref(traceRoot: string, suffix = "", search = ""): string {
  return `${traceRoot}${suffix}${search}`;
}
