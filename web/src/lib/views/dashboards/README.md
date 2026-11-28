# Dashboards

A project's custom dashboards, behind the `customMonitoring` flag. A dashboard is a name and
widgets on a grid. A widget is one query object
(`lib/contracts/query.ts`) and how it is drawn. A metric widget is RQL: a query of kind `sql`,
drawn as a line, a bar, a number or a table, with `form` (the metric form's selection) when the
form wrote its text. Without `form` the text is Custom. No widget has kind `metric`: a stored or
imported one is read as kind `sql` with its form, and saved so.

| File | Holds |
|---|---|
| `types.ts` | the widget and dashboard types, and their limits. `createDashboard` counts the project's dashboards with its insert, under the project's advisory lock, so creates at the same time never pass 100 (`concurrency.test.ts`) |
| `schema.ts` | `dashboards` (migration 0047): the widgets are a jsonb list, each with its place |
| `parse-widget.ts` | `parseWidget`: the shape of a widget from outside, its query's contract, the project's switches, then the chart's rules. It reads an older shape in today's: a metric is kind `sql` with its form, the chart `sql` is the chart its rows drew (`sqlChart`), and a form whose text is not its own any more is dropped (Custom) |
| `legacy-chart.ts` | `sqlChartOfText`: the chart of an older RQL widget (chart `sql`) from its compiled columns: a line for one time column and numbers, else a table. Server only (the compiler) |
| `widget.ts` | `chartProblem`, `changeQuery`, `changeForm` and `fitWidget` (the nearest allowed query and widget, for the editor; a widget of the form gets the text of its selection again), `formWidget`, `formOf`, `metricOfForm`, and the labels; safe for the browser |
| `expanded.ts` | the widget a dashboard shows expanded in place of its grid, in the address (`widget=<id>`; a new widget is made in a dialog, and an older `widget=new` link opens that dialog): a link opens it, a reload keeps it, Back closes it, and the range and filter stay. `hasUnsavedChanges` (the guard of Cancel, Escape and Close) and `expandsCard` (a click on a card's body, not a drag or a control in it); safe for the browser |
| `filters.ts` | the dashboard's filters: in the address, else the saved ones (`filters=none` in the address: no filter at all); environments, services, models, agents and trace properties (`prop.<name>=<value>`, RTL-397; `withBarFilter` is how the property pickers edit the bar); safe for the browser |
| `range.ts` | `resolveWidgetRange`: a preset, whole days, or two exact instants (`range=exact`), as on the Traces page |
| `document.ts`, `json-schemas.ts` | `exportDashboard`, `importDashboard`: a dashboard as a versioned JSON document (`ratel.dashboard`, version 1) without a database id, and the published JSON Schemas (`docs/schemas`) |
| `layout.ts` | a widget as a card of the shared grid (`lib/console/grid`, which has the arithmetic), its sizes, and the first free place |
| `stored-widget.ts` | `readWidgets`, `writeWidgets`: each stored item passes the widget schema again; one that fails is a broken entry with its title and the reason, and goes back as it was |
| `starter.ts` | the four widgets of "Start from the traces overview" |
| `store.ts` | the reads and writes; a widget change locks its row |
| `data.ts` | `loadWidget`, `loadWidgets`: the numbers, a few reads at a time, each bounded; a failed one, or one whose switch is off, is null; kind `sql` runs on the RQL path, in a lane as wide as the RQL gate of a project (2), and gives a refusal as `WidgetRefusal`; a refusal of any kind with a fix (a property that is not indexed) is a `WidgetRefusal` too. A query with a group-by runs through `runGroupedQuery` (RTL-398): the values, then each value's query, every read under the widget's timeout of its own; `query_monitoring` reads it the same way. It reads the whole range of the page, up to 372 days, as a metric widget does |
| `grouped.ts` | a group-by of the kinds (RTL-398): the Group by options (none, task, user, session, then the properties as `propertyOptions` lists them), the title of a small chart (a task's name, "No value"), the note of the values left out; safe for the browser |
| `metric-rql.ts` | `metricAsRql`: the RQL text of a selection of the form, for every measure, aggregation, group-by (a trace property is `properties['name'] as <its name in RQL's letters>`, grouped and ordered by the value; user and session are `user_id` and `session_id`), bucket and filter (a property filter is `properties['name'] in (...)`, its absence `properties['name'] is null`, users and sessions `user_id` and `session_id`, tasks `contains(tasks, ...)`; the group-by task is `each(tasks) as task`) (`rate`, `coalesce(sum, 0)`, `each` for a list, `prompts` for the context measures, the trace columns of `scores` for a filter); buckets newest first, so a cut drops the oldest; numbers in plain digits; a scorer by name for a document. `formQuery`, `formBucketOf` and `isFormText` (a text is the form's while it equals the text of its selection after the same normalisation: RQL is never parsed back), `textToRun` (a text of the form follows the window's bucket, as the form did); safe for the browser |
| `properties.ts` | the trace properties of the forms (RTL-396): `PropertyChoices` (the indexed ones with their 50 most frequent values, the detected ones with their source, the entitlement, the upgrade link), `propertyOptions` (the options of a Filter or Group by dropdown under the heading "Trace properties", a detected one muted with "not indexed"), `propertyBlock` (why a detected one cannot be picked: it must be indexed first, or, for a property of the project's own on a plan without the entitlement, it needs a paid plan, with the upgrade link), `propertySettingsHref` (`?property=<name>#trace-properties` opens the settings section on it), and the dropdown values of a dimension (`property:<name>`); safe for the browser |
| `property-choices.ts` | `loadPropertyChoices(projectId, range, { db, entitled, upgradeHref })`: the read of `PropertyChoices` for one project (`listTraceProperties`, then one bounded query of the values, `getPropertyFacets`); a column property is a built-in field, not one of them. Server only |
| `completion-usage.ts` | `loadCompletionUsage(projectId, { db })`: what the RQL field of one project ranks by. The newest `MAX_SAVED_QUERIES` RQL texts of its widgets and alert rules, counted with `countRqlUsage`, and the columns that hold data in the newest `SAMPLE_ROWS` rows per table of the last `SAMPLE_DAYS` days, read through RQL with no run event and only on a console place that is free at once. Every read names the project; a failed or busy table read is left out. The pages start it at load behind `customMonitoring` and stream it to the field. Server only |
| `sql-chart.ts` | `chartChoices`: the charts the rows of an RQL query fill, with the reason for each other one. `sqlAsMetric`: the rows as a chart's series (the 10 of the highest sum, as the form keeps its groups); with a `SqlChartFrame` (the window, the bucket, 0 or nothing for an empty bucket) it draws every bucket of the window and a total only for a count or a sum; rows cut at the row cap leave the buckets they dropped empty, never 0, and the note says so under the chart and in MCP. `drawnChart`: the chart a widget draws, a table when the rows cannot fill the chosen one. `formAsMetric`: the rows of a text of the form as the form's result, so the widget draws as it did. `sqlNumber`, `sqlAsCategories` (bars of a text column). `sqlResultNotes`: the truncated note, shown under a chart as under a table; safe for the browser |
| `chart-model.ts` | what a chart draws: six color slots by group name, "Other", the scale, the axis labels and the number formats |
| `flow-model.ts` | what the flow widget draws: a column per step, one color per name |
| `step-flow-model.ts` | what the step flow widget draws: a lane of cards per step, as many as fit, with the Health map's ribbons (`views/health/flow-journey-layout`); unfolding a bucket or Later is view state |
| `clusters.ts` | the clusters kind: `selectClusters` picks a part of the stored intent map by name and size; it fills `metricSeams.clusters` |
| `geography-model.ts` | what the map widget draws: five steps of one color, from 0 to the highest value |
| `links.ts` | the addresses, and the Traces page with a widget's filter and time range (trace properties, their absence, users and sessions too, and a group of a property, a user or a session) |
| `actions.ts` | `changeDashboard`: one change by a person, after membership, the flag and a support-session check (the pages' server action calls it) |

Chart rules: a metric widget takes a line, a bar, a number or a table. Its rows decide which ones
draw (`chartChoices`): a table any rows, a number one row with one number column, a line one time
column and numbers, a bar a time or a text column and numbers; a second text column is the series.
The editor disables the others, with the reason. A number of the form has no group-by. Every other
query kind has the one chart of its name. The page filter (the dashboard's, or Explore's) applies
to the RQL text when it runs: the compiler keeps the rows whose trace matches, on every table, so
the text of the form gives the form's numbers under a filter
(`metric-rql-parity.integration.test.ts`: every cell of the matrix, also under page filters, and the
alert value by known time; `property-rql-parity.integration.test.ts`: a property filter and
group-by, by the form, by its text and by RQL written by hand, and the refusal of a property that is
not indexed). A widget on a property that is no longer indexed shows "Property is not indexed" with
the link to it in project settings. A new metric widget starts as a table of the newest traces (`NEW_SQL_TEXT`). A refusal of RQL is the widget's result
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
