# Dashboards

A project's custom dashboards, behind the `customMonitoring` flag. A dashboard is a name and
widgets on a grid. A widget is one query object
(`lib/contracts/query.ts`) and how it is drawn.

| File | Holds |
|---|---|
| `types.ts` | the widget and dashboard types, and their limits. `createDashboard` counts the project's dashboards with its insert, under the project's advisory lock, so creates at the same time never pass 100 (`concurrency.test.ts`) |
| `schema.ts` | `dashboards` (migration 0047): the widgets are a jsonb list, each with its place |
| `parse-widget.ts` | `parseWidget`: the shape of a widget from outside, its query's contract, the project's switches, then the chart's rules |
| `widget.ts` | `chartProblem`, `changeQuery` and `fitWidget` (the nearest allowed query and widget, for the editor), and the labels; safe for the browser |
| `filters.ts` | the dashboard's filters: in the address, else the saved ones (`filters=none` in the address: no filter at all); safe for the browser |
| `range.ts` | `resolveWidgetRange`: a preset, whole days, or two exact instants (`range=exact`), as on the Traces page |
| `document.ts`, `json-schemas.ts` | `exportDashboard`, `importDashboard`: a dashboard as a versioned JSON document (`ratel.dashboard`, version 1) without a database id, and the published JSON Schemas (`docs/schemas`) |
| `layout.ts` | a widget as a card of the shared grid (`lib/console/grid`, which has the arithmetic), its sizes, and the first free place |
| `stored-widget.ts` | `readWidgets`, `writeWidgets`: each stored item passes the widget schema again; one that fails is a broken entry with its title and the reason, and goes back as it was |
| `starter.ts` | the four widgets of "Start from the traces overview" |
| `store.ts` | the reads and writes; a widget change locks its row |
| `data.ts` | `loadWidget`, `loadWidgets`: the numbers, a few reads at a time, each bounded; a failed one, or one whose switch is off, is null; kind `sql` runs on the RQL path and gives a refusal as `WidgetRefusal` |
| `edit-as-sql.ts` | `metricAsRql`: the RQL text that gives a metric widget's numbers (`Edit as SQL`), or why it has none yet (a rate, a context metric, a group-by on a list); safe for the browser |
| `sql-chart.ts` | `sqlAsMetric`: the rows of an RQL query as a chart's series, or null for a table; safe for the browser |
| `chart-model.ts` | what a chart draws: six color slots by group name, "Other", the scale, the axis labels and the number formats |
| `flow-model.ts` | what the flow widget draws: a column per step, one color per name |
| `step-flow-model.ts` | what the step flow widget draws: a lane of cards per step, as many as fit, with the Health map's ribbons (`views/health/flow-journey-layout`); unfolding a bucket or Later is view state |
| `clusters.ts` | the clusters kind: `selectClusters` picks a part of the stored intent map by name and size; it fills `metricSeams.clusters` |
| `geography-model.ts` | what the map widget draws: five steps of one color, from 0 to the highest value |
| `links.ts` | the addresses, and the Traces page with a widget's filter and time range |
| `actions.ts` | `changeDashboard`: one change by a person, after membership, the flag and a support-session check (the pages' server action calls it) |

Chart rules: a table needs a group-by, a number has none, a line and a bar take both. Every other
query kind has the one chart of its name. Kind `sql` (RQL text, behind the `rql` flag) has chart
`sql`: a table, or a line when its rows have one time column (`sql-chart.ts`). `parseWidget`
refuses it while the project's `rql` switch is off (`RQL_OFF_PROBLEM`); a stored one stays and shows
a disabled state. The page filter (the dashboard's, or Explore's) applies to it when it runs: the
compiler keeps the rows whose trace matches, on every table, so `Edit as SQL` keeps the form's
numbers under a filter (`edit-as-sql.integration.test.ts`). A refusal of RQL is the widget's result
(`WidgetRefusal`: the message and the fix). `query_monitoring` takes it alone, not as a panel. A move of a flow opens the Traces page for the traces of
its source: the trace filter knows no order, and no skill. A node of a step flow opens the traces that
had it at any step, for the same reason; a skill, an intent and a fold open none. A funnel step opens its traces only when
the trace filter can say exactly which (one tool, no error). A clusters widget reads the stored analysis: it states its
date and that the time range and the filters do not change it, and it draws the Intents page's own
`AsksPack` and `ToolNetwork`, which stay untouched: zoom and drag events stop before they reach them.
An imported funnel keeps the name of the
first scorer the project lacks.
Explore (`../explore`) shows the same widgets without a dashboard: the widget fields, the live result and
the menu links are shared components.
A project starts with no dashboard row.

The dashboard's filters (environment, service, model, agent) and its time range apply to every widget.
A trace must match them and the widget's own filter: a filter is a list of clauses (`and`), and
`../../synthesis/traces/trace-filter-clauses.ts` is the one way to add one.
The two together are 3,072 bytes of JSON at most (`MAX_FILTER_BYTES`): the bar, the editor, an import and
every change refuse more, so View traces always carries them. A measure that cannot be filtered says
"Not filtered". An imported widget whose scorer the project does not have keeps its name
(`missingScorer`) and shows no numbers until it is edited. A row keeps the name of who changed it last: the core has no table of people.
