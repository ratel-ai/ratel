# Ratel sandbox runner protocol — sandbox/v1

> **Experimental preview.** sandbox/v1 may change before the playground ships.

The wire contract between a **controller** (Ratel: the runner gateway) and a **worker** (the
`ratel sandbox dev` runner that loads sandboxes on a developer's machine). The roles are never "client" and
"server": a later hosted runner keeps the same messages and only changes who opens the
connection. The contract is language-neutral. The TypeScript runner (`@ratel-ai/sandbox`) and a
later Python runner speak the same frames.

## Transport

1. The worker calls `POST /api/v1/runner/connect` with `Authorization: Bearer <project key>`. The
   response holds a gateway URL and a 15-minute token.
2. The worker opens `wss://<gateway>/runner?token=<token>` and sends `register`. The controller
   answers `registered` with the limits of the connection.
3. Every frame is one JSON text of at most **65536 UTF-8 bytes**. Send large values by reference.

Provider keys and user code never cross the wire. The worker calls models with local keys. Traces
go to Ratel through the normal OTLP path, and `span.ref` events point at them.

## Envelope

Every frame, in both directions: `{ v, type, id, ts, runId?, seq?, payload }`
([`schema/envelope.schema.json`](schema/envelope.schema.json)).

- `v` — the protocol major version, `1`. Every frame carries it.
- `type` — the message type (below).
- `id` — a unique ID of the frame. `ts` — RFC 3339 time in UTC.
- `runId` — required on every `run.*`, `tool.*` and `events.ack` frame.
- `seq` — required on `run.event` and `run.end`. It starts at 1 per run and grows by 1.
- `payload` — the body. Its schema depends on `type`.

## Messages

[`schema/message.schema.json`](schema/message.schema.json) validates any frame. It dispatches on
`type` to one schema per message in [`schema/messages/`](schema/messages/).

| Type | From | Purpose |
|---|---|---|
| `register` | worker | Runner instance, capabilities, max concurrency, manifest; for a hosted instance `role: instance`, `versionId`, optional `sessionId` |
| `registered` | controller | Connection ID and limits (frame size, ack, lease, confirm timeouts) |
| `manifest.update` | worker | A new manifest after a hot reload |
| `run.start` | controller | Sandbox, session, input, params, tool modes, context, config hash, replay. Idempotent by `runId` |
| `run.ack` / `run.reject` | worker | Within `ackTimeoutMs` (10 s). Reject reasons: `busy`, `unknown_sandbox`, `invalid_params` |
| `run.lease` | worker | Every `leaseIntervalMs` (15 s). None for `leaseTimeoutMs` (60 s) marks the run lost |
| `run.event` | worker | By `seq`: `text.delta`, `tool.call`, `tool.result`, `log`, `span.ref` |
| `run.end` | worker | Status, output or error, usage, trace ID, changed param names |
| `events.ack` | controller | The highest `seq` the controller stored. The worker resends the rest after a reconnect |
| `tool.confirm.request` / `.decision` | worker / controller | Args / `approve`, `edit`, `fake` or `reject`. No decision in `confirmTimeoutMs` (10 min) means reject |
| `tool.fake.request` / `.result` | worker / controller | Call and schemas / result, `isError`, source (`pinned`, `recorded`, `generated`) |
| `run.cancel` | controller | Abort `ctx.signal`. The run ends with status `canceled` |
| `drain` | controller | Open a new connection, then close this one (make-before-break) |

The worker reconnects with a jittered backoff from 1 s to 60 s.

## Manifest

[`schema/manifest.schema.json`](schema/manifest.schema.json): the SDK (language, name, version),
the build (git SHA, dirty flag, optional `revision`: SHA-256 of the sandbox files), the callable providers (**environment variable names only**,
never values) and the sandboxes. A sandbox has an `id`, its input (`structured` with a JSON Schema, or
`chat`), its params in declaration order and its context fields. A param has a `kind`:

- `model` — default `provider/model`, optional `options`.
- `prompt` — the template string, optional `vars`.
- `tools` — the tools with description, schemas, `hint` (`readOnly`, `sideEffect`, `none`),
  `allowReal` and `opaque`.
- `scalar` — `type` `int`, `number`, `bool`, `enum` (with `values`) or `string`, with `min`,
  `max` or `maxLength`.

A param can carry an optional `source`: `declared` (in the sandbox file; the meaning when absent)
or `sdk` (a tool registered on the Ratel SDK, or a prompt or model the code read through the SDK
catalog). The worker sends a `manifest.update` when a run reads a prompt or model that its load
did not reach, so such a param appears after its first run.

A sandbox can also declare, all optional so phase-1 manifests stay valid:

- `output` — `structured` with a JSON Schema of what run() returns, or `text`.
- `state` — `run` (the default when absent: one instance per run) or `session` (one instance per
  session, kept across its turns).
- `image` — what a hosted instance needs, in a provider-neutral shape: `base` (a container image),
  `install` (build commands), `copy` (paths relative to the project root, never outside it),
  `sidecars` (`postgres` with optional `version` and `seed` SQL file, `redis` with optional
  `version`) and `env` (**names only** of the project secrets the instance gets).

The **config hash** is the lowercase hex SHA-256 of the canonical JSON of all resolved param
values. Tool modes, `output`, `state` and `image` are not in it.

## Push contract

[`schema/push/`](schema/push): the HTTP calls of `ratel sandbox push`, per sandbox, with
`Authorization: Bearer <project key>` on the Ratel API calls only:

1. `POST /api/v1/sandboxes/versions` with `{ sandboxId, manifest, bundle: { sha256, bytes, files } }`
   → `201 { versionId, uploadUrl?, uploadHeaders? }`. No `uploadUrl`: the server already has that bundle.
2. `PUT <uploadUrl>` with the tar.gz and the `uploadHeaders`.
3. `POST /api/v1/sandboxes/versions/{versionId}/finalize` with `{ sha256 }`
   → `200 { status: building | ready | failed, playgroundUrl, error? }`.

Errors carry a JSON body `{ error }`: 400 bad manifest, 401/403 bad key, 404 sandboxes off,
409 bundle mismatch, 413 bundle too large.

## Compatibility

A receiver ignores fields it does not recognise, and drops a frame whose `type` it does not know.
New optional fields, new message types and new enum members are additive within v1. A change to
the meaning of an existing shape needs `sandbox/v2`.

## Conformance

[`conformance/`](conformance/) holds self-contained JSON fixtures. Other implementations (the
Ratel Cloud gateway) copy them and check their own validator against them:

- `valid/messages/<type>[.<variant>].json` — at least one per message type. Each MUST validate.
- `valid/manifest/*.json` — each MUST validate against the manifest schema.
- `invalid/messages/*.json`, `invalid/manifest/*.json` — each MUST fail.
- `valid/push/<schema>/*.json` MUST pass `schema/push/<schema>.schema.json`; `invalid/push/<schema>/*.json` MUST fail it.

```bash
pnpm --filter @ratel-ai/sandbox-protocol test
```
