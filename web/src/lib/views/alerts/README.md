# Alerts

A project's alert rules, behind the `customMonitoring` flag. A rule is one query object (a widget's,
without dimensions), an operator, a threshold and a window. Core-owned.

| Table | Holds |
|---|---|
| `alert_rules` | a rule and its current state (migration 0051) |
| `alert_destinations` | where messages go: a channel of the organization's Slack workspace (`../slack`), or a webhook, its URL sealed for the row, and the last 4 characters (migrations 0052 and 0053) |
| `alert_rule_destinations` | which destinations a rule notifies |
| `alert_events` | one row per state change, with the condition and the value of that time. A row with a notice is also the outbox of its message |

| File | Holds |
|---|---|
| `types.ts` | the rule, the states and the limits; safe for the browser |
| `domain.ts` | `nextState`, `breaches`, the evaluation window and interval; pure |
| `parse-rule.ts` | `parseRule`: a rule from outside; its query passes the same contract as a widget's |
| `store.ts` | the reads and writes of rules and their history; `listAlertingRules`: the rules that alert now, for the Overview |
| `evaluate.ts` | `evaluateAlerts`: the due rules under an advisory lock, one transaction each |
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
| `preview.ts` | `loadAlertPreview`: the last 7 days for the form's chart |
| `register.ts` | the `alerts_evaluate` before-step of the drain: evaluate, then deliver |

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
- A message is tried 4 times at most (the first and 3 more), one per tick. `sent_to` keeps a retry
  from repeating it where it arrived. A process that dies between a send and its record can repeat
  that message: the claim ends after 2 minutes.
- A change of the rule evaluates it on the next tick. A paused rule is not evaluated.
- A webhook URL is a secret: sealed with `platform/secret-box` (needs `RATEL_SECRET_KEY`), never read
  back, never in a log, an event, an error or an answer. An error keeps Slack's status and code only.
- A channel that the app cannot post to is saved too, with what to do. Its `access_error` is Slack's
  code of the last refusal; a post that arrives clears it.
- Events: `feature.alerts.fired`, `.recovered`, `.delivery_failed`, `.skipped` (one per rule and process), `.changed` and
  `.destination_changed`, with ids only.
