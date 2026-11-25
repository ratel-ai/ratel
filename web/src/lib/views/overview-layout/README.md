# `lib/views/overview-layout`

Where each person put the Overview's widgets, and which ones they removed, per project (`focusedConsole`).

| File | Holds |
|---|---|
| `domain/layout.ts` | pure: the widgets with their minimum sizes and default places (`WIDGET_CATALOG`), the default layout of the widgets that are offered, and every change (`changeLayout`: move, resize, add, remove, arrange, reset). The grid arithmetic is `lib/console/grid` |
| `domain/stored.ts` | pure: the stored row (`readArrangement`, `changeArrangement`, `storeArrangement`) and the schema of a change from outside |
| `domain/history.ts` | pure: the entry of a change and its words (`nextChange`, `describeChange`), what Undo takes back (`undoTarget`) and the name of a state (`revisionOf`) |
| `ports/store.ts`, `adapters/drizzle-store.ts`, `schema.ts` | `overview_layouts`: one versioned `jsonb` layout per project and person. No row is the default layout. `overview_layout_changes`: its last 25 changes. Both are deleted with the project. An update runs under a per-person lock, and stores the layout, its entry and the drop of the oldest in one transaction |
| `offered.ts` | `projectDashboardsOn`: whether a project has dashboards, so that their widgets can be on the Overview |
| `dashboard-widgets.ts` | the widgets of the project's dashboards, for the picker and for an add |
| `actions.ts` | `readOverviewLayout`, `changeOverviewLayout`, `undoOverviewChange`, `restoreOverviewLayout` and `readOverviewHistory`, which the web and MCP both call. Somebody without access gets `not_found`; an API key and a support session read the default with no read of the store, cannot write, and cannot read a history |
| `readers.ts` | who asks on the web: the console's project scope, and `pageLayout`, which offers no save when the read failed. MCP's reader is in `lib/mcp/operations/overview.ts` |

A person is the session port's `externalId`, the same id as an OAuth MCP caller's `externalUserId`,
so both surfaces show one layout. The open-source edition has one operator. The module has no
background work, so it has no `register.ts`.

## The history

- One change is one save that gives another layout. A drag or a resize is saved when it ends, and
  a keyboard step is a save. A save that changes nothing has no entry. An undo and a restore are
  entries.
- The history is personal, as the layout is: its person is the author of every entry. A change
  through MCP also has the client's name, from the request's User-Agent.
- Undo takes back the latest change that is not taken back yet, so it can go further back. It never
  takes back an undo; it takes back a restore. An undo is an entry too, so 25 changes allow 13
  undos. Undo is not offered when this build cannot read the layout to go back to.
- A write gives the revision that it was made on. Another revision is refused as `stale`, with the
  layout that is there now. The web gives it, but for "Add to Overview" in the menu of a dashboard's widget, which shows no layout. An MCP change can leave it out, as it is made
  on what is there; an MCP undo or restore cannot.
- The revision has a fingerprint of the stored value: a build from before the history changes the
  layout without an entry. Undo then goes back to the last entry.
- A layout or an entry that this build cannot read is not overwritten, and not restored.

## Dashboard widgets

A widget of a dashboard is on the Overview by reference: its entry is `dashboard:<dashboard id>:<widget id>`
(`dashboardItemId`), with its place and the name it had when it was added.

- What it shows is the dashboard's: the widget as it is now, under the dashboard's saved filters, for the
  Overview's window (`home/dashboard-items.ts`). An edit of the source shows on the next load.
- An add gets the name and the size from the dashboard (`LayoutDeps.dashboardWidget`), never from who
  asks. It goes to the bottom. At most 12 (`MAX_DASHBOARD_ITEMS`).
- A source that is gone, or a reference that cannot be read, is a broken item under its old name. It
  can be moved and removed.
- A removal forgets the entry; Undo and Restore bring it back. Reset takes all of them away.
- With dashboards off (`LayoutDeps.dashboardsOn`) the entries are kept and not drawn, as for any
  widget that is not offered, and an add is refused.

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
