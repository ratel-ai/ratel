/** A timestamp as `YYYY-MM-DD HH:MM UTC`, the same on the server and in every browser. */
export function fmtUtc(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
