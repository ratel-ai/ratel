export interface CallableProvider {
  readonly provider: string;
  /** Environment variable names. Never their values. */
  readonly keys: readonly string[];
}

/** The built-in map of a model prefix to the environment variable that holds its key. */
export const PROVIDER_KEYS: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  gateway: "AI_GATEWAY_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openai: "OPENAI_API_KEY",
};

/** The providers whose key is set in `env`, sorted by name. Reads names only. */
export function callableProviders(
  env: Readonly<Record<string, string | undefined>>,
): CallableProvider[] {
  return Object.entries(PROVIDER_KEYS)
    .filter(([, key]) => Boolean(env[key]))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, key]) => ({ provider, keys: [key] }));
}
