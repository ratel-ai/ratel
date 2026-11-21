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

## Chat twins on the AI SDK

A chat twin runs one user turn per run: `input.messages` holds the conversation so far. With
`resolve: aiSdkModels()` from `@ratel-ai/twin/ai-sdk`, a model param becomes an AI SDK
`LanguageModel`: through AI Gateway when `AI_GATEWAY_API_KEY` is set, else through the
project's own `@ai-sdk/anthropic`, `@ai-sdk/openai` or `@ai-sdk/google` package and its key.
The entry imports only the packages your project has. Supports `ai` 6 and 7. The core entry
`@ratel-ai/twin` never imports `ai`.

```ts
// docs-agent.twin.ts
import { twin } from "@ratel-ai/twin";
import { aiSdkChat, aiSdkModels, forwardText } from "@ratel-ai/twin/ai-sdk";
import { streamText } from "ai";
import { docsDefaults } from "./agent.js";

export default twin("docs-agent", {
  params: {
    model: twin.model(docsDefaults.model), // run gets a LanguageModel
    system: twin.prompt(docsDefaults.system),
  },
  input: aiSdkChat(), // run gets { messages: ModelMessage[] }
  context: twin.context({ userId: "demo-user" }), // fixed inputs, not under test
  resolve: aiSdkModels(),
  run: ({ input, params, ctx }) =>
    // forwardText streams each piece to the playground as a text.delta event.
    forwardText(streamText({ ...params, messages: input.messages }).textStream, ctx),
});
```

The manifest lists only the providers the runner can call, by key name. A run whose model no
listed provider can call is rejected (`invalid_params`) with what to set or install. The
playground session ID becomes `gen_ai.conversation.id` on the `invoke_agent <twin id>` root.

## Tools and tool modes

`twin.tools(defaults.tools, hints)` makes the toolset a param. Per run, `run()` gets a toolset of
the same type: edited descriptions applied, disabled tools removed and each `execute` wrapped by
its mode.

```ts
tools: twin.tools(defaults.tools, {
  searchDocs: { readOnly: true },     // real by default
  createTicket: { sideEffect: true }, // fake by default; never real without allowReal: true
  // a tool with no hint runs in confirm mode
}),
```

- `real` runs the production `execute`.
- `fake` checks the arguments against the tool schema, then returns a fake value: from the
  playground (`tool.fake.request`), or locally from `--fake name=<file.json>` or a small model
  with your own key.
- `confirm` waits for a reviewer: approve, edit and approve, fake, or reject
  (`{ "error": "Rejected by reviewer" }`). No decision in 10 minutes rejects. A local run has no
  reviewer, so it rejects.

Tool modes are not in the config hash. A run that asks `real` for a `sideEffect` tool without
`allowReal: true` is refused by the runner, whatever the server sends. Each `execute_tool` span
gets `ratel.tool.mode`, `ratel.tool.fake.source` and `ratel.tool.confirm.decision`.

## Local runs: the `ratel` CLI

```bash
ratel twin list [--json]                    # finds **/*.twin.* and prints the manifest
ratel twin run workflow-label --input in.json --set maxTokens=100
ratel twin run docs-agent --input chat.json --tool createTicket=fake [--fake createTicket=ticket.json]
```

`twin run` prints the output, the names of the changed params and the config hash. A bad id or
value exits non-zero with a message that names the twin and the param. Discovery skips
`node_modules` and build output. The CLI never loads your code itself: a child worker (under
`tsx`) loads the twins and the project's `.env`. `--tool` sets a tool's mode for the run and
`--fake` gives a fake result from a file. A chat twin streams its reply and its tool calls to
stderr.

## The playground runner: `ratel dev`

```bash
RATEL_API_KEY=rtl_... ratel dev [--url https://cloud.ratel.sh]
```

`ratel dev` finds the twins, trades the project key for a 15-minute gateway token
(`POST /api/v1/runner/connect`), opens one outbound websocket (`protocol/twin/v1`), sends
`register` and prints one playground URL per twin. The project key goes to the token exchange
only, never onto the socket. The manifest names provider keys, never their values. A dropped
socket reconnects with a jittered backoff from 1 s to 60 s and a fresh token. A file change
loads the twins in a new child worker and sends `manifest.update` on the same socket, every
time. The manifest's `build.revision` (SHA-256 of the twin files) changes with every edit of a
twin file. A reload that fails to load keeps the last good child and sends nothing. `RATEL_API_KEY` and
`RATEL_URL` come from the environment or the project's `.env`. The CLI parent reads only those
two names from `.env`.

Runs: `ratel dev` answers `run.start` with `run.ack` at once, or `run.reject` (`unknown_twin`,
`invalid_params` against the manifest, `busy`: one run at a time). A repeated run ID re-acks and
does not run again. A live run sends `run.lease` at the controller's interval (15 s). Its events
(`ctx.log(message)` gives a `log` event) carry a `seq` and stay buffered until `events.ack`. After
a reconnect the runner resends every unacked event, in order. `run.end` carries the status, the
output, the changed param names and the trace ID. `run.cancel` aborts `ctx.signal`, and the run
ends `canceled`. `drain` opens the new socket first and closes the old one after `registered`, so
a live run keeps going. No frame is over 64 KB: long `text.delta` text is split, other long values
are cut with a marker. An optional `redact(payload)` in the twin runs on every event and on the
`run.end` payload before they leave the child worker. A file change during a run reloads after it.

Traces: a playground run is a normal Ratel trace. Its root span is `invoke_workflow <twin id>`
with `gen_ai.conversation.id` (the playground session), `ratel.twin.id`,
`ratel.twin.config_hash`, `ratel.twin.run_id`, `ratel.twin.overrides` (names only) and
`ratel.twin.input`. The runner adds one OTLP exporter to `/api/v1/traces` on the tracer provider
your code registered, or registers the only provider when there is none. It exports only the
traces of playground runs, with the resource `deployment.environment.name=playground`,
`ratel.build.*` and `ratel.runner.*` ([CONVENTIONS](../../telemetry/CONVENTIONS.md)).

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
- `src/dev/` — `ratel dev`. `connection.ts` (socket, register, reconnect, drain) and `runs.ts`
  (ack, reject, seq, buffer, lease, cancel; `frame-size.ts`) are the pure twin/v1 state machines
  (`protocol.ts`, `backoff.ts`). The adapters are `connect-http.ts` (token exchange),
  `ws-socket.ts` (the socket) and `child-host.ts` / `child.ts` (the long-lived child worker).
  `runtime.ts` performs the machine's effects. `watch.ts` reloads on a file change.
  `execute.ts` runs one twin under its root span; `tracing.ts` adds the playground exporter.
- `src/test-support/` — fixture twins, a fixture project and an in-process twin/v1 test
  controller (`controller.ts`) that checks every frame against the protocol schemas. Not built.

```bash
pnpm --filter @ratel-ai/twin typecheck
pnpm --filter @ratel-ai/twin lint
pnpm --filter @ratel-ai/twin test
```
