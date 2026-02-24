# Frontend Client Refactor

## Goal

Refactor `@agentified/fe-client` and `@agentified/react` to:
1. Hide AG-UI as an implementation detail
2. Handle full chat context (messages, streaming) not just Agentified events

## Current State

`AgentifiedClient` expects an `AbstractAgent` from `@ag-ui/client`:

```typescript
constructor(agent: AbstractAgent) {
  agent.subscribe({ onEvent: ({ event }) => this.handleEvent(event) });
}
```

This forces users to:
- Install and understand `@ag-ui/client`
- Create the HttpAgent themselves
- Only get Agentified observability, not chat functionality

## New Design

### @agentified/fe-client

```typescript
interface AgentifiedClientConfig {
  // We create AG-UI client internally
  agentUrl: string;
  
  // Optional config
  contextWindowSize?: number;  // For % calculation
  maxEventLogSize?: number;    // Default: 1000
}

class AgentifiedClient {
  // State now includes MESSAGES, not just inspector data
  private messages: Message[] = [];
  private state: InspectorState;
  
  constructor(config: AgentifiedClientConfig) {
    // Create AG-UI HttpAgent internally
    this.agent = new HttpAgent({ url: config.agentUrl });
  }
  
  // NEW: Run agent (only in standalone mode)
  async run(input: { messages: Message[]; context?: Context[] }): Promise<void>
  
  // NEW: Get messages
  getMessages(): Message[]
  
  // NEW: Send message helper
  async sendMessage(content: string): Promise<void>
  
  // Existing
  getState(): InspectorState
  subscribe(listener): Subscription
  reset(): void
}
```

### @agentified/react

```typescript
interface AgentifiedProviderProps {
  agentUrl: string;
  children: ReactNode;
}

function AgentifiedProvider({ agentUrl, children }: AgentifiedProviderProps) {
  // Create client internally, don't require user to create it
  const client = useMemo(() => 
    new AgentifiedClient({ agentUrl }), 
    [agentUrl]
  );
  // ...
}

interface UseAgentifiedResult {
  // Inspector state
  state: InspectorState;
  
  // NEW: Chat functionality
  messages: Message[];
  sendMessage: (content: string) => Promise<void>;
  isLoading: boolean;
  
  // Existing
  reset: () => void;
}

function useAgentified(): UseAgentifiedResult
```

### Usage Example

```tsx
function App() {
  return (
    <AgentifiedProvider agentUrl="/api/agent">
      <Chat />
      <Inspector />
    </AgentifiedProvider>
  );
}

function Chat() {
  const { messages, sendMessage, isLoading } = useAgentified();
  // Render messages, input, etc.
}
```

## Implementation Steps

1. **@agentified/fe-client**
   - [ ] Update `AgentifiedClientConfig` to accept `agentUrl` (required)
   - [ ] Create HttpAgent internally
   - [ ] Add `messages` state tracking (parse TEXT_MESSAGE_* events)
   - [ ] Add `run()` method that calls `agent.runAgent()`
   - [ ] Add `sendMessage()` helper
   - [ ] Add `getMessages()` getter
   - [ ] Keep `@ag-ui/client` as dependency (not peer dep)
   - [ ] Update tests

2. **@agentified/react**
   - [ ] Update `AgentifiedProvider` to accept `agentUrl` prop
   - [ ] Create client internally (don't require user to pass it)
   - [ ] Update `useAgentified()` to expose `messages`, `sendMessage`, `isLoading`
   - [ ] Update tests

3. **Types**
   - [ ] Export `Message` type (re-export from AG-UI or define our own)
   - [ ] Add `isLoading` to state

## Acceptance Criteria

- [ ] User can use Agentified with just `<AgentifiedProvider agentUrl="/api/agent">`
- [ ] `useAgentified()` returns messages and sendMessage
- [ ] All existing tests pass
- [ ] New tests for message handling
- [ ] TypeScript compiles cleanly

## Notes

- AG-UI `HttpAgent` has `runAgent(input, subscriber)` method
- Messages come through as `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END` events
- Check AG-UI docs for exact message/event types
- Keep Inspector functionality working (it's still valuable)
