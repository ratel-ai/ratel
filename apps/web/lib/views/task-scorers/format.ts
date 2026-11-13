/** "$0.0123": model costs per run are small, so four places. */
export function formatUsd(value: number): string {
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

/** "6.2\u00a0s". */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}\u00a0s`;
}
