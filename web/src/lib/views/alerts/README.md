# Alerts

A project's alert rules, behind the `customMonitoring` flag. A rule is one query object (a widget's,
without dimensions), an operator, a threshold and a window. Core-owned.

| Table | Holds |
|---|---|
| `alert_rules` | a rule and its current state (migration 0051) |
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
- A rule has no destination yet: the notifier of the step tells nobody.
- A message is tried 4 times at most (the first and 3 more), one per tick. `sent_to` keeps a retry
  from repeating it where it arrived. A process that dies between a send and its record can repeat
  that message: the claim ends after 2 minutes.
- A change of the rule evaluates it on the next tick. A paused rule is not evaluated.
- Events: `feature.alerts.fired`, `.recovered`, `.delivery_failed`, `.skipped` (one per rule and process)
  and `.changed`, with ids only.
