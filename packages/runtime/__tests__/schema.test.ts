import { describe, it, expect } from "vitest"
import { AgentConfigSchema, type AgentConfig } from "../src/config/schema"

describe("AgentConfigSchema", () => {
  describe("valid configs", () => {
    it("parses minimal valid config", () => {
      const config = {
        version: "1",
        agent: {
          id: "test-agent",
          name: "Test Agent",
        },
        model: {
          provider: "openai",
          model: "gpt-4o",
        },
        persona: {
          system: "You are a helpful assistant.",
        },
      }

      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.version).toBe("1")
        expect(result.data.agent.id).toBe("test-agent")
        expect(result.data.model.provider).toBe("openai")
      }
    })

    it("parses full config with all fields", () => {
      const config: AgentConfig = {
        version: "1",
        agent: {
          id: "full-agent",
          name: "Full Agent",
        },
        model: {
          provider: "anthropic",
          model: "claude-3-5-sonnet-20241022",
          temperature: 0.7,
        },
        persona: {
          system: "You are a helpful assistant.",
        },
        tools: [
          {
            name: "search",
            type: "http",
            endpoint: "https://api.example.com/search",
            description: "Search the web",
          },
          {
            name: "calculator",
            type: "function",
            description: "Perform calculations",
          },
        ],
        knowledge: {
          sources: [
            {
              name: "docs",
              type: "vector",
              provider: "pinecone",
            },
          ],
        },
        context: {
          memory: {
            type: "buffer",
            maxTurns: 10,
          },
        },
        guardrails: {
          input: ["no-pii"],
          output: ["no-harmful-content"],
        },
      }

      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.tools).toHaveLength(2)
        expect(result.data.knowledge?.sources).toHaveLength(1)
        expect(result.data.context?.memory?.maxTurns).toBe(10)
        expect(result.data.guardrails?.input).toContain("no-pii")
      }
    })

    it("accepts google as provider", () => {
      const config = {
        version: "1",
        agent: { id: "test", name: "Test" },
        model: { provider: "google", model: "gemini-pro" },
        persona: { system: "Hello" },
      }

      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
    })

    it("accepts temperature at boundary values", () => {
      const configMin = {
        version: "1",
        agent: { id: "test", name: "Test" },
        model: { provider: "openai", model: "gpt-4o", temperature: 0 },
        persona: { system: "Hello" },
      }

      const configMax = {
        version: "1",
        agent: { id: "test", name: "Test" },
        model: { provider: "openai", model: "gpt-4o", temperature: 2 },
        persona: { system: "Hello" },
      }

      expect(AgentConfigSchema.safeParse(configMin).success).toBe(true)
      expect(AgentConfigSchema.safeParse(configMax).success).toBe(true)
    })
  })

  describe("invalid configs", () => {
    it("rejects missing version", () => {
      const config = {
        agent: { id: "test", name: "Test" },
        model: { provider: "openai", model: "gpt-4o" },
        persona: { system: "Hello" },
      }

      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it("rejects missing agent", () => {
      const config = {
        version: "1",
        model: { provider: "openai", model: "gpt-4o" },
        persona: { system: "Hello" },
      }

      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it("rejects missing model", () => {
      const config = {
        version: "1",
        agent: { id: "test", name: "Test" },
        persona: { system: "Hello" },
      }

      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it("rejects missing persona", () => {
      const config = {
        version: "1",
        agent: { id: "test", name: "Test" },
        model: { provider: "openai", model: "gpt-4o" },
      }

      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it("rejects unknown provider", () => {
      const config = {
        version: "1",
        agent: { id: "test", name: "Test" },
        model: { provider: "unknown-provider", model: "some-model" },
        persona: { system: "Hello" },
      }

      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it("rejects temperature below 0", () => {
      const config = {
        version: "1",
        agent: { id: "test", name: "Test" },
        model: { provider: "openai", model: "gpt-4o", temperature: -0.1 },
        persona: { system: "Hello" },
      }

      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it("rejects temperature above 2", () => {
      const config = {
        version: "1",
        agent: { id: "test", name: "Test" },
        model: { provider: "openai", model: "gpt-4o", temperature: 2.1 },
        persona: { system: "Hello" },
      }

      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it("rejects wrong type for agent.id", () => {
      const config = {
        version: "1",
        agent: { id: 123, name: "Test" },
        model: { provider: "openai", model: "gpt-4o" },
        persona: { system: "Hello" },
      }

      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it("rejects tool without name", () => {
      const config = {
        version: "1",
        agent: { id: "test", name: "Test" },
        model: { provider: "openai", model: "gpt-4o" },
        persona: { system: "Hello" },
        tools: [{ type: "http" }],
      }

      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })

    it("rejects tool without type", () => {
      const config = {
        version: "1",
        agent: { id: "test", name: "Test" },
        model: { provider: "openai", model: "gpt-4o" },
        persona: { system: "Hello" },
        tools: [{ name: "search" }],
      }

      const result = AgentConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    })
  })
})
