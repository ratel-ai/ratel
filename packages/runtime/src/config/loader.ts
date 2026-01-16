import { readFile } from "node:fs/promises"
import { parse as parseYaml } from "yaml"
import { AgentConfigSchema, type AgentConfig } from "./schema"

export function parseConfig(yaml: string): AgentConfig {
  const parsed = parseYaml(yaml)
  const result = AgentConfigSchema.safeParse(parsed)

  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join(", ")
    throw new Error(`Invalid config: ${errors}`)
  }

  return result.data
}

export async function loadConfig(path: string): Promise<AgentConfig> {
  const content = await readFile(path, "utf-8")
  return parseConfig(content)
}
