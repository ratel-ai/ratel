import { type EmbeddingSpec, SkillRegistry, ToolRegistry } from "./index.js";

const valid: EmbeddingSpec[] = [
  { huggingface: "org/model", revision: "main", download: false },
  { local: "/models/local", pooling: "mean" },
  { ollama: "nomic-embed-text" },
  { url: "https://example.test/v1/embeddings", model: "embed", apiKeyEnv: "API_KEY" },
];

// @ts-expect-error embedding sources are mutually exclusive
const mixedSources: EmbeddingSpec = { ollama: "nomic", url: "https://example.test", model: "m" };

// @ts-expect-error apiKeyEnv is valid only for an explicit URL endpoint
const ollamaWithApiKey: EmbeddingSpec = { ollama: "nomic", apiKeyEnv: "API_KEY" };

// @ts-expect-error an object embedding config requires exactly one source
const emptyConfig: EmbeddingSpec = {};

new ToolRegistry("/models/local");
new SkillRegistry({ huggingface: "org/model", revision: "main" });

// @ts-expect-error raw tool registries reject mixed embedding sources too
new ToolRegistry({ ollama: "nomic", url: "https://example.test", model: "m" });

// @ts-expect-error raw skill registries require exactly one object-form source
new SkillRegistry({});

void [valid, mixedSources, ollamaWithApiKey, emptyConfig];
