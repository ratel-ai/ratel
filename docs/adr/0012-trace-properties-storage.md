# 12. Trace properties: key names per project, values in one jsonb column

## Status

Accepted, behind `customMonitoring` (RTL-395).

## Context

Customers send their own span and resource attributes (an organization id, a plan, a release) and
want to filter and group traces by them. Ingest keeps only `gen_ai.*`, `ratel.*` and a few safe
keys in `otel_spans.attributes` and drops every other attribute on purpose: a key of the
customer's own may hold content or personal data. Two things are needed: which keys a project
sends, and the value of chosen keys on each trace, in a structure that serves every project with
no index per project or per key and no DDL at run time.

A property is **detected** when ingest saw its key name, and **indexed** when Ratel stores its
values, so that it works in a filter, a group-by and RQL. **Standard** properties (a curated list
in code: user, session, environment, model, service, organization, release, and the keys of the
instrumentation conventions ingest reads) are indexed at first sight on every plan. A property of
the customer's own (source **user**) is indexed by a person; that is a paid-plan feature through
the entitlements port (`maxIndexedPropertiesPerProject`; the open-source edition answers
unlimited), with a hard cap of 20 per project.

## Decision

**Key names: `trace_property_keys`.** One row per project and name: state (`detected` or
`indexed`), source (`standard` or `user`), first and last sight, an approximate count, and when
the values started to be stored. Ingest records the scalar keys of each export that are not
`gen_ai.*`, `ratel.*`, instrumentation, content, a credential or a location, at most 200 keys of
the user's own per project and 100 characters per key. A standard key is recorded under its
canonical name. One write per export at most, and none for keys this process wrote in the last
hour; the indexed names are read once a minute per project.

**Values: a `properties` jsonb column on `otel_trace_summaries`, with one GIN index
(`jsonb_path_ops`) for every project.** Ingest writes each span's values to
`otel_spans.properties` (the span's own key, then its ancestors' in the export, then its
resource's, cut to 256 characters, as text), and the summary sweep takes, per key, the first span
value in canonical order, so the root span wins. A standard property that is already a summary
column (user `end_user_id`, session `session_id`, environment `environment`, model `models`,
service `service_name`) is never stored a second time. A filter is `properties @> '{"k":"v"}'`
together with the project and the time range; a group-by reads `properties->>'k'` from the
project's rows in the window.

**Fill and erase.** A property that becomes indexed (by a person, or a standard one at first
sight) queues `fill_trace_properties`: the backfill reads the raw store (`otlp_raw_exports`, so
only its retention window) and adds the values to spans and summaries that lack them. Stopping a
property stops capture; its stored values stay until a person erases them, which removes the key
from the project's spans and summaries.

**Measurements (3,000,000 traces in 20 projects, one project with 1,000,000; four properties per
trace; Postgres 16 on a laptop, warm cache, median of 5 runs, `web/scripts/bench-trace-properties.mts`):**

| Read on the 1,000,000-trace project | jsonb + GIN | table + btree |
|---|---|---|
| filter on one organization (27 traces), count and mean, 30 days | 9.3 ms | 3.0 ms |
| filter, newest 50 traces, 30 days | 7.1 ms | 1.8 ms |
| group-by release (count, mean duration), 30 days | 250 ms | 1,486 ms |
| top 50 organizations, 30 days | 433 ms | 211 ms |
| filter on one organization (about 500 traces), 12 months | 11.3 ms | 13.0 ms |
| filter, newest 50 traces, 12 months | 10.5 ms | 4.1 ms |
| group-by release (count, mean duration), 12 months | 1,144 ms | 2,687 ms |
| top 50 organizations, 12 months | 1,752 ms | 532 ms |
| storage for 3,000,000 traces | 33 MB of index (values in the summary row) | 2,014 MB table, 721 MB index |

The table alternative was `trace_properties (project_id, key, value, started_at, trace_id)` with one
btree index on `(project_id, key, value, started_at)`.

Both designs answer a filter on a selective value well under the 500 ms target. A group-by that
reports a metric must join the table back to the summary for each row, which makes the table two
to six times slower there, and it costs about 2.7 GB more for 3,000,000 traces. jsonb wins the
group-by, which the Metric, Flow and Funnel pages need most. A group-by or top values over twelve
months of a 1,000,000-trace project reads every row of the window in both designs (1.1 to 1.8 s with
jsonb): that bound comes from the rows read, not from the design, and the reads run under the
statement timeout of their pool.

**No runtime DDL.** The column and the GIN index exist once for every project (migration `0063`);
a newly indexed key needs no index and no schema change.

## Privacy

With `customMonitoring` on, Ratel stores the key names of every project's traces; the values of
the standard properties, automatically; and the values of a property of the user's own only after a
person indexes it. With the flag off, ingest records and stores none of it. A person stops a
property in Settings > General > Trace properties, or with `change_trace_property` (a column-backed
standard property is a core trace field and cannot be stopped), and erases its stored values there.

## Consequences

- One shared GIN index grows with the values of every project; a key with very many distinct
  values (a request id) bloats it. The 200-key bound, the 256-character cut and the opt-in for keys
  of the user's own keep this bounded.
- Twelve-month group-bys on the largest projects need a pre-aggregate later; the column does not
  prevent one.
- A value set only on a span exported in a later batch than its descendants is still found: the
  sweep reads the whole trace, not one export.
