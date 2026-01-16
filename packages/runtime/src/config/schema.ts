import { z } from "zod"

const ToolSchema = z.object({
  name: z.string(),
  type: z.string(),
  endpoint: z.string().optional(),
  description: z.string().optional(),
})

const KnowledgeSourceSchema = z.object({
  name: z.string(),
  type: z.string(),
  provider: z.string(),
})

const KnowledgeSchema = z.object({
  sources: z.array(KnowledgeSourceSchema),
})

const MemorySchema = z.object({
  type: z.string(),
  maxTurns: z.number().optional(),
})

const ContextSchema = z.object({
  memory: MemorySchema.optional(),
})

const GuardrailsSchema = z.object({
  input: z.array(z.string()),
  output: z.array(z.string()),
})

const ModelSchema = z.object({
  provider: z.enum(["openai", "anthropic", "google"]),
  model: z.string(),
  temperature: z.number().min(0).max(2).optional(),
})

const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
})

const PersonaSchema = z.object({
  system: z.string(),
})

export const AgentConfigSchema = z.object({
  version: z.string(),
  agent: AgentSchema,
  model: ModelSchema,
  persona: PersonaSchema,
  tools: z.array(ToolSchema).optional(),
  knowledge: KnowledgeSchema.optional(),
  context: ContextSchema.optional(),
  guardrails: GuardrailsSchema.optional(),
})

export type AgentConfig = z.infer<typeof AgentConfigSchema>
export type Tool = z.infer<typeof ToolSchema>
export type ModelConfig = z.infer<typeof ModelSchema>
