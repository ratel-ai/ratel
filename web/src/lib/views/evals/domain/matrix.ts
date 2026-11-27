import { z } from "zod";

/**
 * A parameter matrix: for some params of the runtime, a list of values. A run has one variant for
 * each combination of the values (the cartesian product), at most `MAX_COMBINATIONS`. Each variant
 * runs each row with its trials. The params that the matrix does not name keep one value.
 */

export const MAX_COMBINATIONS = 12;
const MAX_PARAM_NAME_CHARS = 100;
const MAX_VALUE_CHARS = 500;

export type MatrixValue = string | number | boolean;
export type Matrix = Record<string, MatrixValue[]>;

const valueSchema = z.union([z.string().max(MAX_VALUE_CHARS), z.number(), z.boolean()]);

/** A matrix as a request gives it. */
export const matrixInputSchema = z
  .record(
    z.string().trim().min(1).max(MAX_PARAM_NAME_CHARS),
    z.array(valueSchema).min(1, "give each param of the matrix a value").max(MAX_COMBINATIONS),
  )
  .refine(
    (matrix) => Object.values(matrix).every((values) => new Set(values).size === values.length),
    "a param of the matrix has the same value two times",
  )
  .refine(
    (matrix) => combinationCount(matrix) <= MAX_COMBINATIONS,
    `the matrix has more than ${MAX_COMBINATIONS} combinations`,
  );

/** The matrix of an eval version: none by default. */
export const matrixSchema = matrixInputSchema.default({});

/** The number of variants of a run with this matrix: 1 with no matrix. */
export function combinationCount(matrix: Matrix): number {
  return Object.values(matrix).reduce((product, values) => product * values.length, 1);
}

/**
 * Each combination, in a fixed order: the params in the order of their names, the values in the
 * order given. One empty combination with no matrix.
 */
export function combinations(matrix: Matrix): Array<Record<string, MatrixValue>> {
  const names = Object.keys(matrix).sort();
  let out: Array<Record<string, MatrixValue>> = [{}];
  for (const name of names) {
    out = out.flatMap((combination) =>
      (matrix[name] ?? []).map((value) => ({ ...combination, [name]: value })),
    );
  }
  return out;
}

/** Why the matrix cannot run on a runtime with these declared params, or null. */
export function matrixProblem(matrix: Matrix, declared: ReadonlySet<string> | null): string | null {
  const count = combinationCount(matrix);
  if (count > MAX_COMBINATIONS) {
    return `The matrix has ${count} combinations. A run has at most ${MAX_COMBINATIONS}.`;
  }
  if (declared === null) return null;
  const unknown = Object.keys(matrix).filter((name) => !declared.has(name));
  if (unknown.length === 0) return null;
  const known = declared.size > 0 ? [...declared].sort().join(", ") : "none";
  return `The runtime does not declare the param ${unknown.join(", ")}. Its params are: ${known}.`;
}

/** The key of a combination: the same values give the same key, in any order. */
export function combinationKey(values: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(values)
      .sort()
      .map((name) => [name, values[name]]),
  );
}
