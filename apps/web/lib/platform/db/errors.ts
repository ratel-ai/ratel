/** Postgres unique-violation detection, through drizzle's wrapping and a `cause` chain. */
export function isUniqueViolation(err: unknown): boolean {
  const codeOf = (e: unknown): unknown =>
    e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  if (codeOf(err) === "23505") return true;
  const cause = err && typeof err === "object" ? (err as { cause?: unknown }).cause : undefined;
  if (codeOf(cause) === "23505") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /duplicate key value violates unique constraint/i.test(msg);
}
