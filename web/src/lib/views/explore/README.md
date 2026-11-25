# Explore

The project's Explore page, behind the `customMonitoring` flag: one to four panels over one time
range and one filter bar. A panel is a dashboard widget without a place (`WidgetInput` of
`../dashboards`), so it has the widget editor's fields, the widget bodies and the widget reads.
Nothing is stored: the address is the whole state.

| File | Holds |
|---|---|
| `types.ts` | what the page shows, and the most panels |
| `state.ts` | `encodePanels`, `decodePanels`: a version and base64url of deflated JSON without what the query contract fills in (version 1, not deflated, still opens); `withPanels` puts it in the address; `panelProblem` is what the editor refuses |
| `starts.ts` | the start panel (traces by day) and the starting points |
| `links.ts` | the addresses: a whole view, one widget, a Traces list; safe for the browser |

The filters are the parameters of a dashboard (`../dashboards/filters.ts`). The time range is a
preset, whole days, or two exact instants (`range=exact`, `../dashboards/range.ts`), which the MCP
link uses.

The URL budget. Node takes 16 KB for the request line and all headers. Panels that do not fit a search
part of 3,000 characters are the fragment, which no request carries; browsers take 1 MB or more. The
trace filter of a query, all clauses together with the filters of the page, is 3,072 bytes of JSON at
most (`../../contracts/filter-budget.ts` has the numbers and their source), so the link to the Traces
page, which the server reads, always carries it. The editor refuses a change over the bound at its
field, and the bar a filter that does not fit a panel, so the screen and the address are always the
same and every panel can be saved, watched and opened. A text a person has not written yet (a step's
name) is kept. Page filters longer than 2,800 characters are packed in the `filters` parameter.

Save to dashboard and View traces read the rows the panel shows. They add the page's
filters to the query's as one more clause (`withPageFilters`), never by a merge of two sets: a trace
can have tools of both. A page filter that the query has already adds none, and is not said to be
included. A long trace filter is one packed
`and` parameter.
