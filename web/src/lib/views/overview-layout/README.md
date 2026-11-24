# `lib/views/overview-layout`

Where each person put the Overview's widgets, and which ones they hid, per project (`focusedConsole`).

| File | Holds |
|---|---|
| `domain/layout.ts` | pure: the widget ids, the default, the minimum sizes and every change (`changeLayout`: move, resize, show, hide, arrange, reset). The grid arithmetic is `lib/console/grid` |
| `domain/stored.ts` | pure: reading a stored value (`readLayout`: an unknown widget is dropped, a missing one is added at the end and visible, a broken value is the default) and the schema of a change from outside |
| `ports/store.ts`, `adapters/drizzle-store.ts`, `schema.ts` | `overview_layouts`: one versioned `jsonb` layout per project and person, deleted with the project. No row is the default layout. An update runs under a per-person lock |
| `actions.ts` | `readOverviewLayout` and `changeOverviewLayout`, which the web and MCP both call. Somebody without access gets `not_found`; an API key reads the default and cannot write; a support session cannot write |
| `readers.ts` | who asks on the web: the console's project scope. MCP's reader is in `lib/mcp/operations/overview.ts` |

A person is the session port's `externalId`, the same id as an OAuth MCP caller's `externalUserId`,
so both surfaces show one layout. The open-source edition has one operator. The module has no
background work, so it has no `register.ts`.
