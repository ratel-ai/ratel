# @ratel-ai/twin

> **Experimental.** The API may change before the Ratel playground ships.

A twin is a small file next to your agent code. It declares the params Ratel can change per run
(model, prompt, scalars) and a `run` function that calls your real entry function. The Ratel
playground and the local `ratel` CLI run it with overrides. Your code owns the defaults.

```ts
// label.twin.ts
import { twin } from "@ratel-ai/twin";
import { labelDefaults, buildLabelPrompt, complete, parseLabel } from "./label.js";

export default twin("workflow-label", {
  params: {
    model: twin.model(labelDefaults.model), // run gets the bare ID: "claude-sonnet-5-5"
    system: twin.prompt(labelDefaults.system),
    maxTokens: twin.int(labelDefaults.maxTokens, { min: 50, max: 2000 }),
  },
  input: twin.structured<LabelInput>(LabelInputJsonSchema),
  run: async ({ input, params }) => parseLabel(await complete(params, buildLabelPrompt(input))),
});
```

In production, read the same defaults through `resolveLocal`. It returns them unchanged and
stamps `ratel.twin.id` and `ratel.twin.config_hash` on the active span, so Ratel can tell a
production run from a changed config:

```ts
const cfg = resolveLocal(labelDefaults, { twin: "workflow-label" });
```

`stampTwinInput(input)` stamps `ratel.twin.input` on the span of one structured item, so a
recorded item can open in the playground.

## Local runs: the `ratel` CLI

```bash
ratel twin list [--json]                    # finds **/*.twin.* and prints the manifest
ratel twin run workflow-label --input in.json --set maxTokens=100 [--tool createTicket=fake]
```

`twin run` prints the output, the names of the changed params and the config hash. A bad id or
value exits non-zero with a message that names the twin and the param. Discovery skips
`node_modules` and build output. The CLI never loads your code itself: a child worker (under
`tsx`) loads the twins and the project's `.env`. `--tool` modes are parsed and stored; they take
effect in a later version.

## The playground runner: `ratel dev`

```bash
RATEL_API_KEY=rtl_... ratel dev [--url https://cloud.ratel.sh]
```

`ratel dev` finds the twins, trades the project key for a 15-minute gateway token
(`POST /api/v1/runner/connect`), opens one outbound websocket (`protocol/twin/v1`), sends
`register` and prints one playground URL per twin. The project key goes to the token exchange
only, never onto the socket. The manifest names provider keys, never their values. A dropped
socket reconnects with a jittered backoff from 1 s to 60 s and a fresh token. A file change
restarts the child worker and sends `manifest.update` on the same socket. `RATEL_API_KEY` and
`RATEL_URL` come from the environment or the project's `.env`. The CLI parent reads only those
two names from `.env`.

## Rules

- An override applies to one run. Values are resolved per run, with no module-level state.
- Ratel sends plain data only. An override outside its param (kind, min/max, enum, length) or
  for an unknown param is rejected with `invalid_params`.
- The config hash is the SHA-256 of the canonical JSON of all param values (models as
  `provider/model`). The same values give the same hash in production and in the runner.
- This entry opens no socket and does no network I/O (`package-purity.test.ts`).

## Layout

- `src/params.ts` — param builders and value checks. `src/twin.ts` — `twin()` and `structured()`.
- `src/resolve.ts`, `src/run.ts` — per-run resolution and one run.
- `src/hash.ts` — canonical JSON and the config hash. `src/manifest.ts`, `src/providers.ts` —
  the `protocol/twin/v1` manifest.
- `src/otel.ts` — `resolveLocal` and `stampTwinInput` (`@opentelemetry/api` peer).
- `src/cli/` — the `ratel` bin (`main.ts`, a separate entrypoint) and its child worker
  (`worker.ts`, `load.ts`), argument parsing, discovery, build info and output.
- `src/dev/` — `ratel dev`. `connection.ts` is the pure twin/v1 connection state machine
  (`protocol.ts`, `backoff.ts`). The adapters are `connect-http.ts` (token exchange),
  `ws-socket.ts` (the socket) and `child-host.ts` / `child.ts` (the long-lived child worker).
  `runtime.ts` performs the machine's effects. `watch.ts` reloads on a file change.
- `src/test-support/` — fixture twins, a fixture project and an in-process twin/v1 test
  controller (`controller.ts`) that checks every frame against the protocol schemas. Not built.

```bash
pnpm --filter @ratel-ai/twin typecheck
pnpm --filter @ratel-ai/twin lint
pnpm --filter @ratel-ai/twin test
```
