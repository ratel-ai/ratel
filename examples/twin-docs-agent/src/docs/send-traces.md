# Send traces

Ratel ingests OpenTelemetry. Point an OTLP exporter at the traces endpoint of your install, `<BASE_URL>/v1/traces` (on Ratel Cloud, `https://cloud.ratel.sh/v1/traces`), with your project key as a Bearer token. Logs go to `/v1/logs`.

The console's **Settings > API keys** page shows a TypeScript and a curl snippet. The curl one posts a single span and answers `202 Accepted`.

Ratel reads the OpenTelemetry GenAI conventions: `invoke_agent`, `chat` and `execute_tool` spans. Set `gen_ai.conversation.id` on every span of a conversation, so the console can group the turns of one session. Message content is optional; without it, session replay is not available.
