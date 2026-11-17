/**
 * Deprecated `gen_ai.system` values whose `gen_ai.provider.name` spelling
 * differs. A value not listed here is already the provider name.
 */
export const GEN_AI_SYSTEM_TO_PROVIDER: Readonly<Record<string, string>> = {
  xai: "x_ai",
  vertex_ai: "gcp.vertex_ai",
  gemini: "gcp.gemini",
  "az.ai.inference": "azure.ai.inference",
  "az.ai.openai": "azure.ai.openai",
  mistral: "mistral_ai",
};

/** The `gen_ai.provider.name` value for a deprecated `gen_ai.system` value. */
export function providerFromGenAiSystem(system: string): string {
  return GEN_AI_SYSTEM_TO_PROVIDER[system] ?? system;
}

/**
 * OpenInference `llm.provider` / `llm.system` values whose `gen_ai.provider.name`
 * spelling differs. A value not listed here is already the provider name.
 */
export const OPENINFERENCE_TO_PROVIDER: Readonly<Record<string, string>> = {
  mistralai: "mistral_ai",
  vertexai: "gcp.vertex_ai",
  google: "gcp.gen_ai",
  aws: "aws.bedrock",
  azure: "azure.ai.openai",
  xai: "x_ai",
};

/** The `gen_ai.provider.name` value for an OpenInference provider or system value. */
export function providerFromOpenInference(value: string): string {
  return OPENINFERENCE_TO_PROVIDER[value] ?? value;
}
