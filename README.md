# Agentified

Developer-first platform for AI agents with decision trace capture. Build agents from YAML config, capture reasoning at runtime, accumulate organizational intelligence over time.

## Why Context Graphs

Enterprise systems capture state but not reasoning. AI agents face the same problem: they lack organizational context to make good decisions.

Agentified captures **decision traces** at runtime—inputs, policies evaluated, reasoning, outcomes—building a context graph that makes agents smarter over time.

```
Config → Runtime → Output
            ↓
      Decision Traces
            ↓
      Context Graph
            ↓
   Precedent + Learning
```

## Packages

| Package | Description |
|---------|-------------|
| [`@agentified/sdk`](./packages/sdk) | Platform API client |
| [`@agentified/runtime`](./packages/runtime) | Agent execution from YAML config |
| [`@agentified/react`](./packages/react) | React hooks and components |
| [`@agentified/cli`](./packages/cli) | Developer CLI |

## Quick Start

```bash
# Install runtime
npm install @agentified/runtime ai

# Create agent config
cat > agent.yaml << 'EOF'
version: "1"
agent:
  id: "my-agent"
  name: "My Agent"
model:
  provider: "openai"
  model: "gpt-4o-mini"
persona:
  system: "You are a helpful assistant."
EOF
```

```typescript
import { createAgent, loadConfig } from '@agentified/runtime';

const config = loadConfig('./agent.yaml');
const agent = createAgent(config);

const response = await agent.run({
  message: "Hello!"
});
```

## Development

```bash
pnpm install          # Install dependencies
pnpm build            # Build all packages
pnpm typecheck        # Type-check all packages
pnpm test             # Run tests
pnpm lint             # Run ESLint
```

## Roadmap

See [Vision: Developer-First Agent Platform with Context Graphs](https://github.com/agentified/agentified/issues/3).

## License

MIT
