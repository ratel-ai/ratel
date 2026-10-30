# `lib/readings/topics` (L4)

What people ask the agent about. The `assign_topics` job reads a project's last 30 days of
closed turns, takes each turn's ask (the user's message, else the model prompt, else the
agent's first search), groups the distinct asks into topics and writes every turn's place:
`trace_topics` (names and one-line descriptions), `trace_turn_topics` (one row per turn:
topic, retry, none or no ask, with sentiment where the user's own words were read) and
`trace_topic_insights` (the numbers and the flows across a conversation's turns). The job is
queued by each signal run through `computeSeams.enqueueTopics`, which `register.ts` fills.

| File | Holds |
|---|---|
| `asks.ts` | each turn's ask and its source; distinct asks; retries (a turn asking the previous turn's question again) |
| `group.ts`, `place.ts` | grouping by wording (the symmetric-BM25 clusterer) and placement: the judge where configured, else where the ask went before, else the topic whose asks share the most words |
| `evolve.ts`, `name.ts` | new topics from what fits none, retirement, and names: one model call per run, or from the asks' own words |
| `sentiment.ts` | positive, neutral or negative, from the user's own words: the judge, else a small lexicon |
| `patterns.ts`, `flows.ts`, `stats.ts` | each topic's tool pattern (the signal run's helper tools set aside), the flows, the per-topic numbers |
| `job.ts`, `queries.ts`, `schema.ts`, `register.ts` | the reading, its reads and writes, the three tables, the registration |

**Model use.** Placement and sentiment ask the judge through `readings/decisions`
(`OPENAI_API_KEY`; `TOPICS_MAX_JUDGE_TOKENS` caps a reading); names need
`ANTHROPIC_API_KEY` (`TOPICS_LABEL_MODEL`, else `TRACE_WORKFLOW_LABEL_MODEL`, else
`readings/model-defaults.ts`). With no key every ask is placed by wording, sentiment comes from
the lexicon and topics are named from their own asks (`label_source = 'words'`); nothing leaves
the process (`readings/no-outbound-without-key.test.ts`).

**Owned files** (the rest mirror upstream): `job.ts` (OpenAI is the one decision engine; the
judge comes from `readings/decisions`), `patterns.test.ts` (a fixture with a neutral tenant),
`schema.ts`, `register.ts` and its test. The Intents page read models (`view`, `explain`,
`map-model`, `flow-layout`, `examples`, `steps`, `steps-load`) are `lib/views/intents/topics-*`.
