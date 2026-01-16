# @agentified/runtime

Capability-based agent runtime with decision graph for context accumulation.

## Installation

```bash
pnpm add @agentified/runtime ai @ai-sdk/openai zod
```

## Core Concepts

- **Capabilities**: Tools the agent can use (query context, take actions, learn)
- **Decision Graph**: Accumulated decisions that become queryable context
- **Traces**: Full execution traces for observability and post-training

## Usage

### Basic Runtime

```typescript
import { createAgentRuntime, parseConfig, createTraceEmitter } from "@agentified/runtime"
import { openai } from "@ai-sdk/openai"

const config = parseConfig(`
version: "1"
agent:
  id: support-agent
  name: Support Agent
model:
  provider: openai
  model: gpt-4o
persona:
  system: You are a helpful support agent.
`)

const runtime = createAgentRuntime(config, {
  model: openai("gpt-4o"),
})

const result = await runtime.invoke({
  message: "How do I reset my password?",
  sessionId: "session-123",
})

console.log(result.response)
```

### With Decision Graph

```typescript
import {
  createAgentRuntime,
  parseConfig,
  createInMemoryDecisionGraph,
  createTraceEmitter,
} from "@agentified/runtime"
import { openai } from "@ai-sdk/openai"

const config = parseConfig(`...`)
const decisionGraph = createInMemoryDecisionGraph()
const traceEmitter = createTraceEmitter()

traceEmitter.addHandler(async (trace) => {
  console.log("Trace:", trace.id, trace.latencyMs + "ms")
})

const runtime = createAgentRuntime(config, {
  model: openai("gpt-4o"),
  decisionGraph,  // Enables search_decisions + learn capabilities
  traceEmitter,
  bootstrap: { userId: "user-456" },
})

// Agent can now query past decisions and save learnings
const result = await runtime.invoke({
  message: "Refund order #123",
  sessionId: "session-123",
})
```

### Custom Capabilities

```typescript
import { z } from "zod"
import type { Capability } from "@agentified/runtime"

const searchDocsCapability: Capability = {
  name: "search_docs",
  description: "Search documentation",
  schema: z.object({
    query: z.string(),
    limit: z.number().optional(),
  }),
  fn: async (args) => {
    // Your search implementation
    return searchDocs(args.query, args.limit)
  },
  policies: {
    visibleWhen: (ctx) => ctx.page === "help",
  },
}

const runtime = createAgentRuntime(config, {
  model: openai("gpt-4o"),
  capabilities: [searchDocsCapability],
})
```

### Streaming

```typescript
for await (const chunk of runtime.stream({
  message: "Tell me a story",
  sessionId: "session-123",
})) {
  if (chunk.type === "text-delta") {
    process.stdout.write(chunk.textDelta ?? "")
  } else if (chunk.type === "capability-call") {
    console.log("Calling:", chunk.capability?.name)
  }
}
```

## API

### Runtime

- `createAgentRuntime(config, options)` - Create runtime instance
- `runtime.invoke({ message, sessionId, context? })` - Execute agent
- `runtime.stream({ message, sessionId, context? })` - Stream agent response
- `runtime.getAvailableCapabilities(context)` - List available capabilities

### Built-in Capabilities (when decisionGraph provided)

- `search_decisions` - Query past decisions for context
- `learn` - Save learnings/constraints to decision graph

### Decision Graph

- `createInMemoryDecisionGraph()` - In-memory graph for dev/testing
- Platform provides persistent implementation (Postgres)

### Traces

- `createTraceEmitter()` - Create trace emitter
- `traceEmitter.addHandler(fn)` - Register trace handler

## Decision Node Types

```typescript
type DecisionNode =
  | ActionDecision    // Capability was called
  | QueryDecision     // Context was queried
  | LearningDecision  // Rule/pattern learned
  | ConstraintDecision // Constraint discovered
```

## License

MIT
