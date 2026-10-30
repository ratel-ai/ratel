# `lib/catalog` (L2)

The catalog contract: the skills a project publishes and the tool definitions the SDKs pull.

| Path | Holds |
|---|---|
| `schema.ts` | `skills`, `tool_definitions` |
| `queries.ts` | published catalog reads, skill CRUD, catalog ETag updates |
| `wire.ts`, `wire-v2.ts` | protocol/v1 and v2 sync shapes and ETags |
| `manage.ts` | Zod inputs for create/edit/status |
| `import.ts` | bulk upsert-by-name for onboarding |
| `pull-route-handler.ts`, `pull-route-handler-v2.ts` | Bearer pull for `GET /v1/catalog` and `/v2/catalog` |
| `serialize.ts`, `resolve-project.ts`, `http.ts` | management API serialization, and session project and skill resolve by membership |
| `agent-tools/` | the full skill shape the console and the agent tools share |
| `skills/` | markdown and model-json helpers for skill bodies |

Routes: `GET /api/v1/catalog`, `GET /api/v2/catalog`, `PUT /api/v1/catalog/snapshot`,
`/api/v1/skills/**`, and the console's `/api/skills-catalog/**`. Copies and owned files are listed in `scripts/platform-sync/map.json`.
