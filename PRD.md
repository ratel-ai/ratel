Fetching PRD from issue #12...
## Context

This is **Phase 2** of the Agentified OSS release.

**Phase 1** ✅ (Done) — Rust Core + Server
- Rust server with tool registration, discovery, hybrid ranking
- Multi-field embeddings
- Docker image

**Phase 2** 🔜 (This issue) — TypeScript SDK + AG-UI Integration
- Enhance SDK with event emission
- Build Mastra adapter for AG-UI stream merging  
- Build frontend client + React Inspector

**Phase 3** (Future) — QuickHR example, Python SDK, sidecar mode

**Key architectural decision:** Frontend never talks to Agentified server directly. All observability data flows through AG-UI protocol from backend → frontend.

👉 **See issue #8 for full architecture overview, API designs, and decision rationale (including comments).**

---

## Overview

Build four TypeScript packages that integrate Agentified with the AG-UI protocol, enabling real-time observability of agent-Agentified interactions through a React Inspector component.

## Tasks

### Package 1: @agentified/sdk (enhance existing)
- [ ] Add `onEvent` callback to `AgentifiedConfig`
- [ ] Emit `agentified:prefetch:start` and `agentified:prefetch:complete` events from `prefetch()`
- [ ] Emit `agentified:discover:start` and `agentified:discover:complete` events from `asDiscoverTool().execute()`
- [ ] Include timing (`durationMs`) in all complete events
- [ ] Include token usage (input, output, cached, reasoning) when available
- [ ] Add event type definitions
- [ ] Add tests for event emission

### Package 2: @agentified/mastra (new)
- [ ] Create `ts-packages/mastra/`
- [ ] Implement `AgentifiedMastraAdapter` class that wraps `MastraAgent` + `Agentified` SDK
- [ ] Wire SDK `onEvent` to RxJS Subject
- [ ] Convert Agentified events to AG-UI `CUSTOM` events (name = event type, value = event data)
- [ ] Merge Subject with MastraAgent's `run()` Observable
- [ ] Expose `run(input: RunAgentInput): Observable<BaseEvent>`
- [ ] Add tests with real Mastra instance

### Package 3: @agentified/fe-client (new)
- [ ] Create `ts-packages/fe-client/`
- [ ] Implement `AgentifiedClient` class wrapping `@ag-ui/client`'s `HttpAgent`
- [ ] Build `InspectorState` tracking:
  - Connection status
  - Current run info (runId, threadId, duration)
  - Agentified interactions (prefetch results, discoveries, current tools)
  - Token usage + context window percentage
  - Streaming metrics (messages, tool calls, time to first token)
  - Full event log (all AG-UI events, flagging `agentified:*` ones)
- [ ] Parse `agentified:*` CUSTOM events and update state accordingly
- [ ] Implement `subscribe(listener)` for state changes
- [ ] Add unit tests

### Package 4: @agentified/react (new, replace empty dir)
- [ ] Create proper package in `ts-packages/react/`
- [ ] Implement `<AgentifiedProvider client={...}>` context provider
- [ ] Implement `useAgentified()` hook returning state, client, run, reset
- [ ] Implement `<Inspector />` component with:
  - Toggle button when closed
  - Tabs: Overview, Agentified, Tokens, Events
  - Overview: run status, streaming metrics
  - Agentified: last prefetch, current tools, discovery calls
  - Tokens: usage breakdown, context window bar
  - Events: scrollable log of all events
- [ ] CSS-only inline styling (no external deps)
- [ ] Position prop (bottom-right, bottom-left, top-right, top-left)
- [ ] Add unit tests with @testing-library/react

## Acceptance Criteria

- All tests passing (`pnpm test` in each package)
- SDK integration tests pass against Dockerized Rust server
- Mastra tests pass with real Mastra agent
- No TypeScript errors
- Inspector renders and updates in real-time
- Events flow: SDK → Mastra adapter → AG-UI stream → fe-client → React Inspector

## Technical Notes

- Use `pnpm` for package management
- Peer dependencies:
  - `@agentified/mastra`: `@ag-ui/client >=0.0.45`, `@ag-ui/mastra >=1.0.0`, `@mastra/core >=0.10.0`
  - `@agentified/fe-client`: `@ag-ui/client >=0.0.45`
  - `@agentified/react`: `react >=18.0.0`
- AG-UI CUSTOM event format: `{ type: "CUSTOM", name: string, value: any }`
- Use RxJS `Subject` and `merge` for stream combination in Mastra adapter
- `@ag-ui/client` exports `HttpAgent` and subscriber pattern with `onTextMessageContentEvent`, `onToolCallStartEvent`, etc.

## Notes for Ralph

- OpenAI API key is in `.env` at repo root
- Start Rust server with `docker compose up -d` in `core/` before running integration tests
- Existing SDK code in `ts-packages/sdk/` is clean — just add `onEvent`, don't restructure
- For Mastra tests, create a minimal test agent that echoes input
- Implementation order: SDK → fe-client (pure unit tests) → react (unit tests) → mastra (integration)
- Check `@ag-ui/mastra` source at https://github.com/ag-ui-protocol/ag-ui for exact types
- Inspector should be functional, not beautiful — keep styling simple
