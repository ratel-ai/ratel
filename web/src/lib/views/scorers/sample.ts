import { createHash } from "node:crypto";

/** Whether a scorer takes this trace: a stable choice, so a retry never changes the sample. */
export function inSample(scorerId: string, traceId: string, sampleRate: number): boolean {
  if (sampleRate >= 100) return true;
  const hash = createHash("sha256").update(`${scorerId}:${traceId}`).digest().readUInt32BE(0);
  return (hash / 2 ** 32) * 100 < sampleRate;
}
