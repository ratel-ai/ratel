/**
 * The `experimentName` a match-quality run carries when it was measured from
 * plain search telemetry rather than a calibration. Dependency-free so any
 * component, client or server, can ask which kind of run it is showing.
 */
export const SEARCH_TELEMETRY_SOURCE = "ratel:search-telemetry";

/** The one engine a search-telemetry run measures. */
export const SEARCH_TELEMETRY_ARM = "ratel";

export function isSearchTelemetry(experimentName: string | null | undefined): boolean {
  return experimentName === SEARCH_TELEMETRY_SOURCE;
}
