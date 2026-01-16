import type { AgentConfig } from "../config/schema"

export interface AssembledContext {
  systemPrompt: string
  toolNames: string[]
}

export function assembleContext(config: AgentConfig): AssembledContext {
  return {
    systemPrompt: config.persona.system,
    toolNames: config.tools?.map((t) => t.name) ?? [],
  }
}
