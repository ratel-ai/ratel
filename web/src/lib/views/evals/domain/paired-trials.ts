/** The trials of the two sides with the same index. A trial with no other one is alone. */
export function pairedTrials<T extends { index: number }>(
  baseline: readonly T[] | null,
  candidate: readonly T[] | null,
): Array<{ index: number; baseline: T | undefined; candidate: T | undefined }> {
  const [left, right] = [baseline ?? [], candidate ?? []];
  const indexes = new Set([...left, ...right].map(({ index }) => index));
  const at = (trials: readonly T[], index: number) => trials.find((trial) => trial.index === index);
  return [...indexes]
    .sort((a, b) => a - b)
    .map((index) => ({ index, baseline: at(left, index), candidate: at(right, index) }));
}
