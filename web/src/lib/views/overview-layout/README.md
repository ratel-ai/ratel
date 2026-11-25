# `lib/views/overview-layout`

Where each person put the Overview's widgets, and which ones they removed, per project (`focusedConsole`).

| File | Holds |
|---|---|
| `domain/layout.ts` | pure: the widgets with their minimum sizes and default places (`WIDGET_CATALOG`), the default layout of the widgets that are offered, and every change (`changeLayout`: move, resize, add, remove, arrange, reset). The grid arithmetic is `lib/console/grid` |
| `domain/stored.ts` | pure: the stored row (`readArrangement`, `changeArrangement`, `storeArrangement`) and the schema of a change from outside |
| `ports/store.ts`, `adapters/drizzle-store.ts`, `schema.ts` | `overview_layouts`: one versioned `jsonb` layout per project and person, deleted with the project. No row is the default layout. An update runs under a per-person lock |
| `actions.ts` | `readOverviewLayout` and `changeOverviewLayout`, which the web and MCP both call. Somebody without access gets `not_found`; an API key and a support session read the default with no read of the store, and cannot write |
| `readers.ts` | who asks on the web: the console's project scope, and `pageLayout`, which offers no save when the read failed. MCP's reader is in `lib/mcp/operations/overview.ts` |

A person is the session port's `externalId`, the same id as an OAuth MCP caller's `externalUserId`,
so both surfaces show one layout. The open-source edition has one operator. The module has no
background work, so it has no `register.ts`.

## A later widget

Add it to `WIDGET_CATALOG`. Behind a flag, give it only in `LayoutDeps.offered` (the web: `readers.ts`;
MCP: `OverviewOperationDeps.offeredWidgets`). Give it a read (`home/focused-load`), a
body (`widget-bodies`), a title (`widgets.ts`) and an entry in `WIDGET_DATA`: `get_overview` then reads
and draws it alone too. Nobody's layout is reset, and nothing is migrated:

- A stored layout keeps every place and removal. The new widget is at the bottom, visible, one time.
  After its removal it stays removed.
- The entry of a widget that is not offered is kept through read, change and save, and is never
  drawn. When the widget is offered again, it has its place and state. Two builds at once during a
  deploy work the same way.
- Reset is the default of the offered widgets, and the only change that forgets the kept entries.
- Only a value that does not parse, or that names a widget twice, reads as the default. It is not
  overwritten: every change but reset is refused with `unreadable`.

A removed widget is stored as `hidden: true`.
