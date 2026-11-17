/**
 * Whether a project's spans have their deprecated `gen_ai.*` keys and OpenLLMetry aliases read
 * (`normalizeSemconvAliases`), and their `gen_ai` log events kept and joined.
 *
 * Owned (ADR-0030): upstream decides `cloud-otlp-semconv-aliases` per organization through its
 * flag service, and retires it in #402, reading the aliases for everyone. Here that end state
 * lands at once: always on. The name and signature stay upstream's so the callers are its.
 */
export type SemconvAliasesEnabled = (projectId: string, organization: unknown) => Promise<boolean>;

export const SEMCONV_ALIASES_FLAG = "cloud-otlp-semconv-aliases";

export async function semconvAliasesEnabled(
  _projectId: string,
  _organization: unknown,
): Promise<boolean> {
  return true;
}
