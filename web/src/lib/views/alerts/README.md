# Alerts

A project's alert rules, behind the `customMonitoring` flag. A rule is one query object (a widget's,
without dimensions), an operator, a threshold and a window. Core-owned.

| Table | Holds |
|---|---|
| `alert_rules` | a rule and its current state (migration 0051) |
| `alert_destinations` | where messages go: a channel of the organization's Slack workspace (`../slack`), or a webhook, its URL sealed for the row, and the last 4 characters (migrations 0052 and 0053) |
| `alert_rule_destinations` | which destinations a rule notifies |
| `alert_events` | one row per state change, with the condition and the value of that time. A row with a notice is also the outbox of its message. Kept 90 days (index of migration 0054) |

| File | Holds |
|---|---|
| `types.ts` | the rule, the states and the limits; safe for the browser |
| `domain.ts` | `nextState`, `breaches`, the evaluation window and interval; pure |
| `parse-rule.ts` | `parseRule`: a rule from outside; its query passes the same contract as a widget's. A rule is RQL (kind `sql`), with the metric form's selection (ungrouped) when the form wrote the text: `parseAlertQuery` reads an ungrouped metric (an older stored rule, or a caller's) as `alertFormQuery` of it, and the next save writes that shape. The text is compiled at save and must give one row with one number (`sqlAlertProblem`) |
| `sql-value.ts` | `measureSqlValue`: the value of an RQL rule over its window on the read-only RQL path, or the error that marks it failing. The evaluator reads on the reserved alert path (`reserved`, so `purpose: "alert"`): a gate of its own, one query per project, and a timeout of `RQL_LIMITS.alertTimeoutMs` (2 s), so a busy dashboard never fails a rule. A preview of the form stays on the interactive path, so it never queues in front of a rule. It reads by known time (`by: "known"`: `traces.known_at`, `scores.scored_at`), so a late trace counts when it arrives, and a sum of nothing is 0 (`coalesce`), as the metric form gave (`metric-rql-parity.integration.test.ts`) |
| `store.ts` | the reads and writes of rules and their history; `pruneAlertEvents`: the retention; `listAlertingRules`: the rules that alert now, for the Overview |
| `evaluate.ts` | `evaluateAlerts`: the due rules under an advisory lock, one transaction each, one rule of each project in turn, and at most `PROJECT_TIME_BUDGET_MS` (5 s) of a tick for one project's rules. Every rule reads its RQL value before its transaction, on the alert path; a refusal sets `last_error` (failing: no state change, no message) and the next read clears it |
| `deliver.ts` | `deliverAlerts`: claims and sends the pending messages |
| `notifier.ts` | the `AlertNotifier` port, with `memoryNotifier` for tests |
| `actions.ts` | `changeAlert`: one change by a person, after membership, the flag and a support-session check |
| `destinations.ts` | the reads and writes of destinations; only `webhookOf` opens a URL |
| `destination-actions.ts` | `changeDestination`: add a channel or a webhook, test and remove, after the same checks as `changeAlert` |
| `slack-url.ts` | `parseSlackWebhook`: the one address check, on save and again before each send |
| `slack.ts` | `slackNotifier`, the notifier the step uses, and `postTo`: by the Slack app (`../slack`) or by webhook |
| `slack-message.ts` | the fire, recovery and test messages |
| `webhook-post.ts` | one POST with a deadline and no redirect, on `node:https`: a `fetch` span carries the URL |
| `format.ts`, `links.ts` | how an alert reads, and the pages' addresses; safe for the browser |
| `preview.ts` | `loadAlertPreview`: for a rule of the form, its last 7 days through RQL (the text of its selection by bucket); for a Custom text, its value now or its error |
| `register.ts` | the `alerts_evaluate` before-step of the drain: evaluate, then deliver; the `alert_events_prune` after-step |

Rules:

- The states are `ok`, `alerting` and `no_data`. A value on the threshold does not alert.
- An alert reads what became known in its window: a trace by `updated_at` of its summary (it ends
  before it is known), a scorer result by `scored_at`. So a trace longer than the window counts.
  Dashboards and the form's chart read by the start of the trace. A trace whose summary is written
  again (a late span) counts again. Captured prompts (`context_*`) count by their own time.
- A count or a sum of nothing is 0, which is a value: "Traces below 10" alerts on silence. A rate, an
  average or a percentile of nothing is `no_data`.
  A rule whose stored query is malformed needs
  attention: the pages say why, and a tick skips it and keeps its state.
- A fire and a recovery are one message each. `no_data` sends nothing and keeps `firing`, so an
  alert that loses its data neither fires twice nor loses its recovery.
- A rule is evaluated each tick (60 seconds), about every 5 minutes for a window of a day.
- The messages of a project whose flag is off stay pending, with a log, and a tick leaves them out
  of its next reads: they never hold up another project's. A message still pending after a day
  expires unsent (`failed`, with a log): a message that late says nothing of now.
- A message is tried 4 times at most (the first and 3 more), one per tick. `sent_to` keeps a retry
  from repeating it where it arrived. A process that dies between a send and its record can repeat
  that message: the claim ends after 2 minutes.
- A project has 100 rules and 20 destinations at most. The count and the insert are one
  transaction under the project's advisory lock (`platform/db/project-lock.ts`), so creates at the
  same time never pass them (`concurrency.test.ts`, with `TEST_POSTGRES_URL`).
- A change of the rule evaluates it on the next tick. A paused rule is not evaluated.
- A webhook URL is a secret: sealed with `platform/secret-box` (needs `RATEL_SECRET_KEY`), never read
  back, never in a log, an event, an error or an answer. An error keeps Slack's status and code only.
- A channel that the app cannot post to is saved too, with what to do. Its `access_error` is Slack's
  code of the last refusal; a post that arrives clears it.
- The history keeps 90 days (the owner's choice). Each tick, `alert_events_prune` deletes one batch
  of 5,000 older rows at most, the oldest first, whatever `DATA_RETENTION_ENABLED` says: the history
  is the alerts' own log and outbox, not telemetry. A message still pending is never pruned.
- Events: `feature.alerts.fired`, `.recovered`, `.delivery_failed`, `.skipped` (one per rule and process), `.changed` and
  `.destination_changed`, with ids only.
