# @ratel-ai/sandbox

> **Experimental.** The API may change before the Ratel playground ships.

A sandbox is a small file next to your agent code. It declares the params Ratel can change per run
(model, prompt, scalars) and a `run` function that calls your real entry function. The Ratel
playground and the local `ratel` CLI run it with overrides. Your code owns the defaults.

```ts
// label.sandbox.ts
import { sandbox } from "@ratel-ai/sandbox";
import { labelDefaults, buildLabelPrompt, complete, parseLabel } from "./label.js";

export default sandbox("workflow-label", {
  params: {
    model: sandbox.model(labelDefaults.model), // run gets the bare ID: "claude-sonnet-5-5"
    system: sandbox.prompt(labelDefaults.system),
    maxTokens: sandbox.int(labelDefaults.maxTokens, { min: 50, max: 2000 }),
  },
  input: sandbox.structured<LabelInput>(LabelInputJsonSchema),
  run: async ({ input, params }) => parseLabel(await complete(params, buildLabelPrompt(input))),
});
```

In production, read the same defaults through `resolveLocal`. It returns them unchanged and
stamps `ratel.sandbox.id` and `ratel.sandbox.config_hash` on the active span, so Ratel can tell a
production run from a changed config:

```ts
const cfg = resolveLocal(labelDefaults, { sandbox: "workflow-label" });
```

`stampSandboxInput(input)` stamps `ratel.sandbox.input` on the span of one structured item, so a
recorded item can open in the playground.

## Chat sandboxes on the AI SDK

A chat sandbox runs one user turn per run: `input.messages` holds the conversation so far. With
`resolve: aiSdkModels()` from `@ratel-ai/sandbox/ai-sdk`, a model param becomes an AI SDK
`LanguageModel`: through AI Gateway when `AI_GATEWAY_API_KEY` is set, else through the
project's own `@ai-sdk/anthropic`, `@ai-sdk/openai` or `@ai-sdk/google` package and its key.
An `amazon-bedrock/<model id>` value (for example
`amazon-bedrock/eu.anthropic.claude-haiku-5-5`) goes through the project's
`@ai-sdk/amazon-bedrock`. It needs `AWS_REGION` and AWS credentials: `AWS_ACCESS_KEY_ID` or
`AWS_BEARER_TOKEN_BEDROCK`, which the package reads itself, or `AWS_PROFILE` (SSO or a shared
file), web identity or container credentials, through `fromNodeProviderChain` of the project's
`@aws-sdk/credential-providers`. The manifest lists the names of the AWS variables that are set,
never their values.
The runner imports `ai` and the provider from the project of the sandbox file (never from where
`@ratel-ai/sandbox` is installed), so the model and your `streamText` come from the same `ai`. Supports `ai` 6 and 7. The core entry
`@ratel-ai/sandbox` never imports `ai`.

```ts
// docs-agent.sandbox.ts
import { sandbox } from "@ratel-ai/sandbox";
import { aiSdkChat, aiSdkModels, forwardText } from "@ratel-ai/sandbox/ai-sdk";
import { streamText } from "ai";
import { docsDefaults } from "./agent.js";

export default sandbox("docs-agent", {
  params: {
    model: sandbox.model(docsDefaults.model), // run gets a LanguageModel
    system: sandbox.prompt(docsDefaults.system),
  },
  input: aiSdkChat(), // run gets { messages: ModelMessage[] }
  context: sandbox.context({ userId: "demo-user" }), // fixed inputs, not under test
  resolve: aiSdkModels(),
  run: ({ input, params, ctx }) =>
    // forwardText streams each piece to the playground as a text.delta event.
    forwardText(streamText({ ...params, messages: input.messages }).textStream, ctx),
});
```

The manifest lists only the providers the runner can call, by key name. A run whose model no
listed provider can call is rejected (`invalid_params`) with what to set or install. The
playground session ID becomes `gen_ai.conversation.id` on the `invoke_agent <sandbox id>` root.

## Tools and tool modes

`sandbox.tools(defaults.tools, hints)` makes the toolset a param. Per run, `run()` gets a toolset of
the same type: edited descriptions applied, disabled tools removed and each `execute` wrapped by
its mode.

```ts
tools: sandbox.tools(defaults.tools, {
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

## Hosted sandboxes: image, output and state

A sandbox file can also say what a hosted instance needs. The shape is provider-neutral: no
provider type is in this package. run() can be any async function, also one with no model.

```ts
export default sandbox("docs-agent", {
  params: { /* ... */ },
  input: aiSdkChat(),
  output: sandbox.text(), // or sandbox.output<{ total: number }>({ type: "object", ... })
  state: "run", // "run" (default): one instance per run. "session": one per session.
  image: sandbox.image({
    base: "node:22-slim",
    install: ["corepack enable", "pnpm install --frozen-lockfile"],
    copy: ["."], // relative to the project root, never outside it
    sidecars: [sandbox.postgres({ version: "16", seed: "db/seed.sql" })], // sets DATABASE_URL
    env: ["AI_GATEWAY_API_KEY"], // names only: the values come from the project secrets
  }),
  run: async ({ input, params, ctx }) => reply(input.messages, params, ctx),
});
```

`sandbox.redis()` adds a Redis sidecar (`REDIS_URL`). An `env` entry with a value (`NAME=value`)
and a `copy` or `seed` path that is absolute or leaves the project root throw at load time. All
three fields go into the manifest. The config hash stays the hash of the resolved param values.
`ratel sandbox verify` on a sandbox with only scalar params and no model call reports each param as
skipped with the reason, not as failed.

### Register a version: `ratel sandbox push`

```bash
ratel sandbox push --dry-run [--out bundle.tar.gz]   # lists the bundle files, uploads nothing
ratel sandbox push [<id>] [--url <ratel url>]        # every discovered sandbox when no id
```

Push bundles the project as a tar.gz: in a git work tree, the files git lists (tracked and
untracked, minus `.gitignore`). Outside one, a walk that applies the `.gitignore` files (root and
nested, with negations) as git does. When git fails inside a work tree, push is refused: it never
falls back to a walk. `.env*` files, `node_modules`, `.git` (a folder or a file) and build output
are never in it. `--dry-run` prints which rules it used. A bundle over 50 MB fails with the size and the file count. Per sandbox,
push creates a version with the manifest and the git SHA and dirty flag, uploads the bundle and
finalizes it, then prints the version id and its playground URL. It reads `RATEL_API_KEY` and
`RATEL_URL` like `ratel sandbox dev`. The contract is in
[`protocol/sandbox/v1/schema/push`](../../../protocol/sandbox/v1/schema/push).
`pnpm push-stub -- --port 4200` starts a local stub of it for demos.

### Inside a hosted container: `ratel sandbox serve`

`ratel sandbox serve` is the container entrypoint. It reads `RATEL_INSTANCE_TOKEN` and
`RATEL_GATEWAY_URL` from the env, loads the sandboxes of the bundle in the working folder and
dials `<gateway>/runner?token=…`. It needs no project key and does no token exchange. It
registers with `role: instance` and the version and session ids of the token, then serves runs
over the same sandbox/v1 protocol as `ratel sandbox dev`, with no file watcher. It exits 0 on
`drain`, on SIGTERM, or when the socket stays closed after the reconnect backoff
(`RATEL_INSTANCE_MAX_RECONNECTS`, default 5). Secrets arrive as plain env vars and are never
logged. The user code never sees the instance token. Traces go to `RATEL_URL` with the instance
token as bearer and `ratel.sandbox.instance=hosted`.

## Local runs: the `ratel` CLI

```bash
ratel sandbox list [--json]                    # finds **/*.sandbox.* and prints the manifest
ratel sandbox run workflow-label --input in.json --set maxTokens=100
ratel sandbox run docs-agent --input chat.json --tool createTicket=fake [--fake createTicket=ticket.json]
```

`sandbox run` prints the output, the names of the changed params and the config hash. A bad id or
value exits non-zero with a message that names the sandbox and the param. Discovery skips
`node_modules` and build output. The CLI never loads your code itself: a child worker (under
`tsx`) loads the sandboxes and the project's `.env`. `--tool` sets a tool's mode for the run and
`--fake` gives a fake result from a file. A chat sandbox streams its reply and its tool calls to
stderr.

### Prove each param is wired: `ratel sandbox verify`

```bash
ratel sandbox verify docs-agent [--input chat.json] [--model anthropic/claude-haiku-5.5] [--dry]
```

`sandbox verify` runs the sandbox once with no overrides, then once per param with a sentinel
override, and reads the spans of each run from an in-memory span processor:

| Param | Wired when |
|---|---|
| `prompt` | A unique sentinel appended to the prompt shows in a model-call span (a span with `gen_ai.request.model`). |
| `model` | `gen_ai.request.model` equals a second model: `--model`, else a param option, else a built-in alternate of a callable provider. With no second callable model, the check is skipped. |
| `tools` | A sentinel in each description shows in the tool definitions, a disabled tool is absent, and each called tool has `ratel.tool.mode` on its `execute_tool` span. |
| scalar | `maxTokens`, `temperature`, `topP` and `topK` must show as `gen_ai.request.*`. Other scalars are reported as "cannot verify automatically". |
| config hash | It changes with each override. With no overrides it equals the hash `resolveLocal` stamps for the sandbox's `defaults`. |

The input is `--input`, else the sandbox's `example`. The worker registers the only tracer provider
before your code loads and turns content capture on for its own process, so the sentinels and the
captured content stay in memory and are never exported. Verify calls your model with your keys.
`--dry` swaps the models of an AI SDK sandbox for a stand-in that calls each tool once, and fakes
side effects with a fixed value. The command exits 1 when a param is not wired, and names it.
Pass `defaults` (the object production gives `resolveLocal`) and `example` to `sandbox()` to check
the production hash and to run without `--input`.

## The playground runner: `ratel sandbox dev`

```bash
RATEL_API_KEY=rtl_... ratel sandbox dev [--url https://cloud.ratel.sh]
```

`ratel sandbox dev` finds the sandboxes, trades the project key for a 15-minute gateway token
(`POST /api/v1/runner/connect`), opens one outbound websocket (`protocol/sandbox/v1`), sends
`register` and prints one playground URL per sandbox. The project key goes to the token exchange
only, never onto the socket. The manifest names provider keys, never their values. A dropped
socket reconnects with a jittered backoff from 1 s to 60 s and a fresh token. A file change
loads the sandboxes in a new child worker and sends `manifest.update` on the same socket, every
time. The manifest's `build.revision` (SHA-256 of the sandbox files) changes with every edit of a
sandbox file. A reload that fails to load keeps the last good child and sends nothing. Hot reload
watches the project root and the folders of the sandbox files and their local imports, never
`node_modules`, `.git` or build output. Where `fs.watch` fails (for example, a sandbox that denies
macOS FSEvents gives `EMFILE`), it polls those files every 0.5 s instead. `RATEL_SANDBOX_WATCH=poll`
polls from the start. `RATEL_API_KEY` and
`RATEL_URL` come from the environment or the project's `.env`. The CLI parent reads only those
two names from `.env`.

Runs: `ratel sandbox dev` answers `run.start` with `run.ack` at once, or `run.reject` (`unknown_sandbox`,
`invalid_params` against the manifest, `busy`: one run at a time). A repeated run ID re-acks and
does not run again. A live run sends `run.lease` at the controller's interval (15 s). Its events
(`ctx.log(message)` gives a `log` event) carry a `seq` and stay buffered until `events.ack`. After
a reconnect the runner resends every unacked event, in order. `run.end` carries the status, the
output, the changed param names and the trace ID. `run.cancel` aborts `ctx.signal`, and the run
ends `canceled`. `drain` opens the new socket first and closes the old one after `registered`, so
a live run keeps going. No frame is over 64 KB: long `text.delta` text is split, other long values
are cut with a marker. An optional `redact(payload)` in the sandbox runs on every event and on the
`run.end` payload before they leave the child worker. A file change during a run reloads after it.

Traces: a playground run is a normal Ratel trace. Its root span is `invoke_workflow <sandbox id>`
with `gen_ai.conversation.id` (the playground session), `ratel.sandbox.id`,
`ratel.sandbox.config_hash`, `ratel.sandbox.run_id`, `ratel.sandbox.overrides` (names only) and
`ratel.sandbox.input`. The runner adds one OTLP exporter to `/api/v1/traces` on the tracer provider
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

- `src/params.ts` — param builders and value checks. `src/sandbox.ts` — `sandbox()` and `structured()`.
- `src/resolve.ts`, `src/run.ts` — per-run resolution and one run.
- `src/hash.ts` — canonical JSON and the config hash. `src/manifest.ts`, `src/providers.ts` —
  the `protocol/sandbox/v1` manifest.
- `src/otel.ts` — `resolveLocal` and `stampSandboxInput` (`@opentelemetry/api` peer).
- `src/cli/` — the `ratel` bin (`main.ts`, a separate entrypoint) and its child worker
  (`worker.ts`, `load.ts`), argument parsing, discovery, build info and output.
- `src/dev/` — `ratel sandbox dev`. `connection.ts` (socket, register, reconnect, drain) and `runs.ts`
  (ack, reject, seq, buffer, lease, cancel; `frame-size.ts`) are the pure sandbox/v1 state machines
  (`protocol.ts`, `backoff.ts`). The adapters are `connect-http.ts` (token exchange),
  `ws-socket.ts` (the socket) and `child-host.ts` / `child.ts` (the long-lived child worker).
  `runtime.ts` performs the machine's effects. `watch.ts` reloads on a file change.
  `execute.ts` runs one sandbox under its root span; `tracing.ts` adds the playground exporter.
- `src/test-support/` — fixture sandboxes, a fixture project and an in-process sandbox/v1 test
  controller (`controller.ts`) that checks every frame against the protocol schemas. Not built.

```bash
pnpm --filter @ratel-ai/sandbox typecheck
pnpm --filter @ratel-ai/sandbox lint
pnpm --filter @ratel-ai/sandbox test
```
