# Dashboards

A project's custom dashboards, behind the `customDashboards` flag. A dashboard is a name and an
ordered list of widgets. A widget is one `lib/synthesis/metrics` request and how it is drawn.

| File | Holds |
|---|---|
| `types.ts` | the widget and dashboard types, and their limits |
| `schema.ts` | `dashboards` (migration 0044): the widgets are a jsonb list in order |
| `parse-widget.ts` | `parseWidget`: the shape of a widget from outside, then the metric catalog's and the chart's rules |
| `widget.ts` | `chartProblem`, `fitWidget` (the nearest allowed widget, for the editor), and the labels; safe for the browser |
| `starter.ts` | the four widgets of "Start from the traces overview" |
| `store.ts` | the reads and writes; a widget change locks its row |
| `data.ts` | `loadWidget`, `loadWidgets`: the numbers, a few reads at a time, each bounded; a failed one is null |
| `chart-model.ts` | what a chart draws: six color slots by group name, "Other", the scale, the axis labels and the number formats |
| `links.ts` | the addresses, and the Traces page with a widget's filter and time range |
| `actions.ts` | `changeDashboard`: one change by a person, after membership, the flag and a support-session check (the pages' server action calls it) |

Chart rules: a table needs a group-by, a number has none, a line and a bar take both.
A project starts with no dashboard row.
