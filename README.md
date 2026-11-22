# proof/rp-69 (ratel): Trace ratel-app in Datadog APM, core side

Twin of ratel-platform `proof/rp-69`. Branch `beluga/rp-69-trace-ratel-app-datadog`, draft PR #384 (ratel-platform #120).

Commit pair for every log here: ratel `08519a9a` / ratel-platform `c06fec32`. Each log starts with its date, the pair, the folder and the command; it ends with the command's exit code.

| Log | Shows |
|---|---|
| `gitleaks.log` | gitleaks on the history the head reaches, repo config and `.gitleaksignore` applied, `--redact`: no leaks, exit 0 |
| `typecheck-oss.log` | OSS typecheck, without `ee/src` |
| `typecheck-cloud.log` | Cloud typecheck, ratel-platform at `ee/src` |
| `test-server-traces.log` | server-traces unit tests (no endpoint: no server traces; no Datadog package), the boot test with only `OTEL_EXPORTER_OTLP_ENDPOINT` (request and outbound spans, resource, no query string, no model-call or MCP span), self-telemetry boot tests (nothing registered when unset) |
| `test-feature-spans.log` | the `withFeatureSpan` contract and its wiring at the Agents/MCP page contexts and tool-run insights |
| `checks-boundary-layers-private.log` | `check:boundary`, `check:layers`, `check:private` |
| `lint.log` | ee lint then platform lint: no errors |
| `ci-jobs.txt` | ratel CI on the head (dispatched: CI skips drafts): every job's conclusion |
| `pr-384.json` | The draft PR record |

Handoffs (RP-69, RP-70, RP-71, RP-105, RP-106) and the staging items deferred until the owner deploys: see ratel-platform `proof/rp-69` README.
