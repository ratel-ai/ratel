import { describe, it, expect } from "vitest"
import { loadConfig, parseConfig } from "../loader"

const validYaml = `
version: "1"
agent:
  id: test-agent
  name: Test Agent
model:
  provider: openai
  model: gpt-4o
persona:
  system: You are a helpful assistant.
`

const fullYaml = `
version: "1"
agent:
  id: full-agent
  name: Full Agent
model:
  provider: anthropic
  model: claude-3-5-sonnet-20241022
  temperature: 0.7
persona:
  system: You are a helpful assistant.
tools:
  - name: search
    type: http
    endpoint: https://api.example.com/search
    description: Search the web
knowledge:
  sources:
    - name: docs
      type: vector
      provider: pinecone
context:
  memory:
    type: buffer
    maxTurns: 10
guardrails:
  input:
    - no-pii
  output:
    - no-harmful-content
`

describe("parseConfig", () => {
  it("parses valid YAML string and returns validated config", () => {
    const config = parseConfig(validYaml)

    expect(config.version).toBe("1")
    expect(config.agent.id).toBe("test-agent")
    expect(config.agent.name).toBe("Test Agent")
    expect(config.model.provider).toBe("openai")
    expect(config.model.model).toBe("gpt-4o")
    expect(config.persona.system).toBe("You are a helpful assistant.")
  })

  it("parses full YAML config with all fields", () => {
    const config = parseConfig(fullYaml)

    expect(config.tools).toHaveLength(1)
    expect(config.tools?.[0]?.name).toBe("search")
    expect(config.knowledge?.sources).toHaveLength(1)
    expect(config.context?.memory?.maxTurns).toBe(10)
    expect(config.guardrails?.input).toContain("no-pii")
  })

  it("throws on invalid YAML syntax", () => {
    const invalidYaml = `
version: "1"
agent:
  id: test
  name: Test
  invalid yaml here: [unclosed
`

    expect(() => parseConfig(invalidYaml)).toThrow()
  })

  it("throws validation error with path for invalid schema", () => {
    const invalidSchema = `
version: "1"
agent:
  id: test
  name: Test
model:
  provider: invalid-provider
  model: some-model
persona:
  system: Hello
`

    expect(() => parseConfig(invalidSchema)).toThrow(/provider/)
  })

  it("throws when required field is missing", () => {
    const missingField = `
version: "1"
agent:
  id: test
  name: Test
model:
  provider: openai
  model: gpt-4o
`

    expect(() => parseConfig(missingField)).toThrow(/persona/)
  })
})

describe("loadConfig", () => {
  it("loads config from file path", async () => {
    const config = await loadConfig(
      new URL("./fixtures/valid-config.yaml", import.meta.url).pathname
    )

    expect(config.version).toBe("1")
    expect(config.agent.id).toBe("fixture-agent")
  })

  it("throws when file does not exist", async () => {
    await expect(loadConfig("/nonexistent/path.yaml")).rejects.toThrow()
  })
})
