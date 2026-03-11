# py-sdk-smoke

Minimal smoke test for the Python SDK. Mirrors [ts-sdk-smoke](../ts-sdk-smoke).

## Prerequisites

```bash
docker run -p 9119:9119 \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -e AGENTIFIED_STORAGE=sqlite \
  agentified/agentified-core
```

## Run

```bash
uv run python main.py
```

## Checks

1. Connect to server
2. Register tools (get_weather, search_docs)
3. Create session
4. `update_conversation` — persist 3 messages
5. `conversation.messages()` — verify 3 stored
6. `context.messages(strategy="recent").assemble()` — verify 3 context msgs
7. `discover_tool.execute()` — discover tools (skip on API key error)
8. `get_messages(strategy="recent")` — verify 3 msgs
9. `conversation.append()` — add 1 msg, verify 4 total
10. `update_conversation` dedup — resend same 4, verify still 4
