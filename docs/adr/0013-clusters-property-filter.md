# 13. Clusters: filter and split the stored analysis by a trace property, through the turn link

## Status

Proposed (RTL-399). No code yet.

## Context

The other widget kinds of a dashboard take a property filter and a group-by (ADR-0012, RTL-396,
RTL-397): the runner adds `traceFilterCondition` (`web/src/lib/synthesis/traces/trace-filters.ts:85`)
to its read of traces, and a group-by reads `properties->>'k'` or runs the query once per value with
one more filter. The Clusters kind cannot do this. It reads no trace. It reads the stored analysis:
"no trace filter and no time range" (`web/src/lib/contracts/query.ts:458`). The console says so under
the widget (`web/src/components/console/dashboards/ClustersBody.tsx:98`), and `isFilterable` is false
for it (`web/src/lib/views/dashboards/widget.ts:300`).

**Where the analysis is computed.** The `assign_topics` job, `assignProjectTopics`
(`web/src/lib/readings/topics/job.ts:574`, the reading itself in `read` at `job.ts:626`). In the code
an intent cluster is a "topic". One reading covers the project's last 30 days of closed turns
(`web/src/lib/readings/topics/types.ts:15`), the newest 20,000 at most
(`web/src/config-defaults.ts:200`). It takes each turn's ask, places the distinct asks in the topics
there are, makes new topics from groups of asks that fit none, and names them.

**How often it runs.** Each signal run queues one reading (`web/src/lib/readings/topics/register.ts:15`,
`web/src/lib/readings/trace-signals/signals/compute-job.ts:633`). Signal runs come from the daily sweep
(`web/src/lib/readings/trace-signals/sweep-service.ts:18`) and from new data. A waiting reading is
coalesced. The job budget is 5 minutes (`web/src/lib/jobs/policy.ts:54`).

**What it costs in model calls.** Per reading, at most 300 distinct asks are placed by the judge and
at most 300 are read for sentiment (`web/src/config-defaults.ts:202-203`), with a cap of 2,000,000
judge input tokens (`config-defaults.ts:204`). Placement can run twice in one reading, when the topic
set changed. New topics are named by one model call, at most 12 names (`types.ts:24`), with room for
16,000 output tokens (`job.ts:156`). Verdicts are cached per ask and topic set, so a reading pays only
for new asks. Without model keys, every step falls back to wording and costs no model call.

**Where it is stored.** `saveTopicReading` (`web/src/lib/readings/topics/queries.ts:335`, called at
`job.ts:803`) writes three tables in one transaction (`web/src/lib/readings/topics/schema.ts`):

- `trace_topics` (`schema.ts:16`): one row per project and topic. Names and descriptions only.
- `trace_turn_topics` (`schema.ts:43`): one row per closed turn. Its topic, or verdict `retry`,
  `none` (fits no topic) or `no_ask`, the ask source and hash, sentiment and the turn's start.
- `trace_topic_insights` (`schema.ts:74`): one row per project, replaced by each reading. The
  numbers per topic (turns, daily turns, answered, tools, tasks) as jsonb.

The widget reads the latest reading (`web/src/lib/views/intents/topics-read.ts:7`) into the map model
(`web/src/lib/views/intents/topics-map-model.ts:42`). The size of a cluster is the topic's `turns`
from the insights (`topics-map-model.ts:83`, counted at `web/src/lib/readings/topics/stats.ts:239`),
and its tool links are the topic's tool counts. The selection is `selectClusters`
(`web/src/lib/views/dashboards/clusters.ts:46`).

**Does an ask link to its trace?** Yes, through its turn, for most asks:

- `trace_turn_topics.turn_id` references `trace_turns.id` (`schema.ts:46-48`).
- An OTLP turn has the key `otlp:<trace id>` (`web/src/lib/ledger/schema.ts:44-45`, written at
  `web/src/lib/ledger/turns/segment.ts:276`), with an index on `(project_id, turn_key)`
  (`ledger/schema.ts:102-104`). `otel_trace_summaries` has the key `(project_id, trace_id)` and holds
  `properties`. So turn, then trace, then property is two indexed joins.

The link has three gaps:

1. **Model-only traces.** A trace of model calls alone has no ledger turn. The reading counts it in
   its topic but writes no `trace_turn_topics` row (`types.ts:63-68`, filtered at `job.ts:805`). Its
   placement is lost after the reading.
2. **Runtime-lane turns.** A declared or inferred turn from the SDK's own events has no trace id.
   Properties exist only on OTLP traces, so these turns have no property value in any case.
3. **Turns with no trace id.** An OTLP turn keyed on its session (`segment.ts:276`, when the event had
   no trace id) or on a run (`otlp-run:`) does not join one trace.

Also, `trace_turn_topics` rows are upserted and never deleted, so a read must keep only the rows of
the latest reading's window (`readFrom` to `end` in the insights). And span retention is 30 days
(`web/src/config-defaults.ts:42`), the same as the reading window: a trace near the start of the
window can lose its summary before the next reading, and its ask then has no value.

## Options

### (a) One analysis, split by the ask-to-trace link

Keep the one reading. At query time, join `trace_turn_topics` (rows of the latest reading) to
`trace_turns` on `turn_key = 'otlp:' || trace_id` and to `otel_trace_summaries`, with the property
filter of the other kinds on the summary. Count turns per topic and per value. The tools view counts
the filtered turns' tool steps from `trace_turn_steps`.

- **Compute.** One read of at most about 20,000 turn rows of one project with two indexed joins, per
  widget. Not measured. ADR-0012 measured a 30-day group-by over 1,000,000 traces at 250 ms; this read
  is smaller. It runs under the dashboard read pool's statement timeout.
- **Model calls.** None.
- **Storage.** None for the base version. Closing gap 1 needs the model-only placements stored: a
  small table keyed on `(project_id, trace_id)`, at most one row per model-only trace in the window.
- **Latency.** Same as the other widgets. A new value works at once, with no job to wait for.
- **What the user sees.** The same clusters, with the same names, in every value. With a filter, each
  cluster's size is its asks of that value, and a cluster with none of them is hidden. With a
  group-by, each cluster shows one bar or segment per value (the top values, "other" and "no
  value"). The counts of `none` and `retry` turns per value come for free: "34 asks of plan=free fit no
  cluster" is a useful signal.
- **Limits.** The clusters are those of the whole project. A segment with its own small intent can
  find it under "fits no cluster" or inside a near cluster, because a new topic needs 1% of all asks
  (`types.ts:31`). Asks in gaps 1 to 3 count as "no value". The window stays the reading's 30 days,
  not the page's range (the turn rows hold `started_at`, so the page range could narrow it later).
  Answered share and sentiment per value need more columns in the read; the first version gives
  sizes only.

### (b) One analysis per property value

Run `assign_topics` once per value of the property, on the turns of that value.

- **Compute.** One job of up to 5 minutes per value, per signal run. A property with 50 values is 50
  jobs, and a project can index 20 properties (ADR-0012).
- **Model calls.** Each reading has its own topic set, so the verdict cache is not shared. Per value
  and per reading: up to 300 placement asks (twice when the set changed), up to 300 sentiment asks
  and one naming call. For 50 values that is up to 50 times the cost of today's reading, each day and
  on new data.
- **Storage.** A segment key in all three tables and their primary keys. `trace_turn_topics` is
  keyed on `turn_id` alone today, so a turn could not sit in two segmentations without a new key.
- **Latency.** A value has no clusters until its job ran. A value with few asks gives few or no
  clusters (a topic needs 5 turns, `config-defaults.ts:201`).
- **What the user sees.** Different clusters, with different names, in each value. "Billing
  questions" in one value and "Payments" in another cannot be compared side by side, so a group-by
  view is not possible, only a filter.
- **Limits.** The cost grows with the number of values and is paid whether a dashboard shows them or
  not. A filter of two or more properties needs one reading per combination.

### (c) Do nothing for Clusters

- **Cost.** None.
- **What the user sees.** The widget stays unfiltered. The footnote says the page's filters do not
  change it. A dashboard filtered to `plan=enterprise` shows the clusters of every plan next to
  widgets of one plan, which can mislead.
- **Limits.** The question "what do the users of this plan ask about" has no answer in a dashboard.

## Decision

Proposed: **option (a)**. Keep one analysis. Filter and group the Clusters widget by an indexed
property through `trace_turn_topics`, `trace_turns.turn_key` and `otel_trace_summaries.properties`.
Show per value the size of each existing cluster, plus the asks that fit no cluster.

- The `clusters` query takes the same `properties` and `withoutProperties` filter as the other kinds
  and an optional `groupBy: { property }`. The page filter applies to it, and `isFilterable` becomes
  true for it.
- The footnote names what the split cannot see: "N asks have no trace and count as no value".
- Store the model-only placements (gap 1) in the same change only if that count is large on real
  projects. Measure it first.
- The same query object serves the MCP tools, so the console and MCP stay at parity.

**Effort.** About 4 days for the base version: the contract and its schema (0.5 day), the runner's
read and its integration test with properties (1.5 days), the per-value view in `ClustersBody` and
the form (1.5 days), MCP parity and proof (0.5 day). Plus 1 to 2 days to store model-only
placements, if the count calls for it.

## Consequences

- Clusters take the same filter as every other widget, at no model cost and no new job.
- The clusters stay those of the whole project. A segment's own small intents are not found; they
  show as "fits no cluster" for that value. Option (b) stays possible later, for one chosen value, if
  that proves to matter.
- The split depends on the turn rows of the latest reading. A change to how `assign_topics` writes or
  prunes `trace_turn_topics` must keep that link.
- Asks without a trace (runtime-lane turns, model-only traces until they are stored) never carry a
  property value.
