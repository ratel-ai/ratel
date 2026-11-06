# Real-library OTLP fixtures

Raw OTLP/HTTP trace export bodies, exactly as each library's own exporter sent
them (gzipped for the repo; `gunzip -c <file>` gives the bytes on the wire).
`.json.gz` is OTLP/JSON, `.pb.gz` is protobuf. Several bodies in a folder are
several export requests, in the order they were sent (the file name starts
with the receive time).

Captured on 2026-10-01, offline: every model was a mock or a local fake
OpenAI-compatible server, so nothing secret is inside. The capture scripts,
their pinned dependencies and the shared spec (`SPEC.md`) are in
`apps/web/scripts/otel-fixtures/`.

Every capture ran the same agent: one conversation (`sess-<folder>`, user
`user-42` where the library has a place for them), three requests one second
apart, one tool per model round trip:

1. "Find the Falcon login bug and assign it to Ada": search_tasks, get_task, assign_task (4 model calls)
2. "What is on Ada's plate this week?": get_user, list_tasks (3 model calls)
3. "Archive the stale Orion board": find_board, archive_board (raises), notify (4 model calls)

Mock token usage is input `100 * k + 10 * request`, output 20, so the runs
total 1040/80, 660/60 and 1120/80. Content capture was on wherever it is
opt-in. `lib/otlp/real-fixtures.test.ts` pins what our pipeline reads from
each folder.

| Folder | Library and versions | How |
| --- | --- | --- |
| `vercel-ai` | `ai` 7.0.126, `@ai-sdk/otel` 1.0.126, OTel JS sdk-trace-node 2.11.0, exporter-trace-otlp-http 0.222.0 (JSON) | `generateText` with `MockLanguageModelV4`, `registerTelemetry(new OpenTelemetry({ runtimeContext: true }))`; session via `runtimeContext` (ai 7 ignores `metadata`) |
| `vercel-ai-stream` | same | `streamText`, request 1 only |
| `mastra` | `@mastra/core` 1.73.0, `@mastra/observability` 1.18.3, `@mastra/otel-exporter` 1.4.4 (JSON) | `agent.generate` with memory thread `sess-mastra`, AI SDK mock model |
| `langgraph-openinference` | langgraph 1.2.12, langchain-core 1.6.6, openinference-instrumentation-langchain 0.1.77, OTel Python 1.45.0 (protobuf) | `create_react_agent`, scripted fake chat model, `handle_tool_errors=True`, `using_session` / `using_user` |
| `openai-agents-openinference` | openai-agents 0.22.3, openai 3.22.1, openinference-instrumentation-openai-agents 2.5.1 | `Runner.run` against a local fake chat completions server, `using_session` |
| `openai-agents-openinference-plus-openai` | same plus openinference-instrumentation-openai 0.1.62 | same run with the OpenAI client instrumented too (nested LLM spans) |
| `openllmetry-openai` | traceloop-sdk 0.62.4, opentelemetry-instrumentation-openai 0.62.4, openai 3.22.1 | hand-written loop, `@workflow` / `@tool`, `set_association_properties` and `@conversation` |
| `pydantic-ai` | pydantic-ai-slim 2.52.0 (instrumentation version 5), OTel Python 1.45.0 | `FunctionModel`, `Instrumentation` capability, `conversation_id=`; a plain exception aborts run 3 |
| `pydantic-ai-modelretry` | same | `archive_board` raises `ModelRetry` instead, so run 3 completes |
| `mcp-python-fastmcp` | fastmcp 4.0.10, mcp 2.2.0 (native OTel), legacy stateful mode | client and server both exporting; the client propagates `traceparent` in `_meta` |
| `mcp-python-fastmcp-modern` | same, default stateless mode (protocol 2026-07-28) | `mcp.session.id` is a new id per request; extra root `tools/list` traces |
| `mcp-python-fastmcp-server-only` | same, legacy mode | client not instrumented: every `tools/call` is its own root trace |
| `mcp-python-sdk-native` | mcp 2.2.0 native OTel (`MCPServer`) | both sides; client spans are `MCP send tools/call <tool>`, no session id anywhere |
| `mcp-python-sdk-native-server-only` | same | server only: one root trace per call, nothing links them |
| `mcp-python-openinference` | mcp 2.2.0 plus openinference-instrumentation-mcp 2.0.11 | the instrumentation only propagates context; spans are the SDK's own |
| `mcp-python-traceloop` | mcp 1.30.0, opentelemetry-instrumentation-mcp 0.62.4 (crashes on mcp 2.2.0) | client `<tool>.tool` spans; server spans carry no tool name |
| `mcp-ts-sdk` | `@modelcontextprotocol/sdk` 1.31.0, `@arizeai/openinference-instrumentation-mcp` 0.2.34 | propagation only, no tool spans at all |
| `mcp-ts-sdk-traceloop` | `@modelcontextprotocol/sdk` 1.31.0, `@traceloop/instrumentation-mcp` 0.27.0 | one session-long client trace holds every call; server makes no spans |

In the MCP folders the conversation id and user id sit on the capture
client's own `agent request N` span (no MCP library emits them), and some
server captures add a `handler <tool>` span inside each tool body (scope
`pm-tool-handler`) because the instrumentation under test makes none.
