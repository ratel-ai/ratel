# Alerts

A project's alert rules, behind the `alerts` flag. A rule is one `lib/synthesis/metrics` query (a
widget's, without a grouping), an operator, a threshold and a window. Core-owned.

| Table | Holds |
|---|---|
| `alert_rules` | a rule and its current state (migration 0046) |
| `alert_events` | one row per state change, with the condition and the value of that time. A row with a notice is also the outbox of its message |

| File | Holds |
|---|---|
| `types.ts` | the rule, the states and the limits; safe for the browser |
| `domain.ts` | `nextState`, `breaches`, the evaluation window and interval; pure |
| `parse-rule.ts` | `parseRule`: a rule from outside; its query passes the widget's own rules |
| `store.ts` | the reads and writes of rules and their history |
| `evaluate.ts` | `evaluateAlerts`: the due rules under an advisory lock, one transaction each |
| `deliver.ts` | `deliverAlerts`: claims and sends the pending messages |
| `notifier.ts` | the `AlertNotifier` port, with `memoryNotifier` for tests |
| `actions.ts` | `changeAlert`: one change by a person, after membership, the flag and a support-session check |
| `register.ts` | the `alerts_evaluate` before-step of the drain: evaluate, then deliver |

Rules:

- The states are `ok`, `alerting` and `no_data`. A value on the threshold does not alert.
- A window without rows is `no_data`, also for a count: "Traces below 1" does not alert on silence.
  So is a metric that left the catalog or whose switch is off.
- A fire and a recovery are one message each. `no_data` sends nothing and keeps `firing`, so an
  alert that loses its data neither fires twice nor loses its recovery.
- A rule is evaluated each tick (60 seconds), about every 5 minutes for a window of a day.
- A message is tried 4 times at most (the first and 3 more), one per tick. `sent_to` keeps a retry
  from repeating it where it arrived. A process that dies between a send and its record can repeat
  that message: the claim ends after 2 minutes.
- A change of the rule evaluates it on the next tick. A paused rule is not evaluated.
- Events: `feature.alerts.fired`, `.recovered`, `.delivery_failed` and `.changed`, with ids only.
