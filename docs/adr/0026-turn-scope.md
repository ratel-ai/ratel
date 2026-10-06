# 26. Turn scope: one marked request, turn ids by default, external tool calls

Date: 2026-10-01

## Status

Accepted

Extends [ADR-0020](0020-runtime-events-lane.md) (one additive event type, `turn_start`) and
[ADR-0014](0014-adaptive-usage-ranking.md) (who supplies `turn_id`).

## Context

Ratel Cloud groups runtime events into runs per `(session_id, turn_id)`. Three gaps kept real
deployments from producing usable runs:

- `session_id` is one value per process, so a server handling many users at once looks like one
  session.
- `turn_id` existed on the envelope, but only when the caller threaded a `turnId` argument
  through every search and invoke. Few callers do, so Cloud fell back to guessing run boundaries
  from quiet gaps, and concurrent requests blended.
- A tool call was recorded only when it ran through `invoke`. Hosts whose framework runs tools
  itself sent searches and nothing else.

Nothing told Cloud what the user asked either; it used a run's first search query as a stand-in.

## Decision

### A turn scope in both SDKs

`ratel().turn(fn, { id?, userMessage?, endUserId? })` (TypeScript; also on `ToolCatalog` and
every adapted view) and `with catalog.turn(id=None, *, user_message=None, end_user_id=None):`
(Python, sync and async) mark one user request once. The scope is `AsyncLocalStorage` in
TypeScript and a `contextvars` variable in Python, so it follows the request through `await` and
the tasks it starts while concurrent requests keep their own. Inside it:

- every event the SDK records (search, skill search and load, invoke lifecycle, gateway events,
  SDK-owned experiment events) carries the turn's `turn_id`, and its `end_user_id` when given;
- an explicit `turnId` / `turn_id` argument still wins, and a nested scope wins over its outer
  one (inheriting the outer `end_user_id` unless it sets its own);
- the id defaults to a fresh ULID, so the SDK now mints turn ids. ADR-0014's "caller-supplied
  only" is narrowed accordingly: the caller still decides where a turn starts.

`currentTurnId()` / `current_turn_id()` read the innermost id.

### `turn_start`

Opening a scope records one core `TraceEvent::TurnStart` (wire `turn_start`) with the turn's
`turn_id`, `end_user_id`, and active OTel `trace_id`/`span_id` on the envelope. Its only payload
field is `user_message`, present only when the caller passed it: passing it is the consent. It is
capped at 4 KiB of UTF-8 like a search query. A turn starts once per catalog: reopening an id
already started (a resumed stream, an adapter joining the host's turn) emits nothing. `turn_start`
joins the remotely publishable set as an additive type, which ADR-0020 already allows. The usage
learner ignores it; pairing stays keyed by `turn_id` on the events themselves.

### External tool calls

`recordToolCall({ toolId, tookMs?, error?, turnId? })` / `record_tool_call(tool_id, *, took_ms=None,
error=None, turn_id=None)` record a tool the host's framework ran as the same lifecycle `invoke`
records: `invoke_start` (`args_size_bytes: 0`), then `invoke_end` or `invoke_error` with
`took_ms` and `error`, sharing one `invocation_id`, inside the current turn. They feed the usage
learner exactly as an invoke does, because the learner pairs a search with the tool the agent
chose (`invoke_start`), whoever ran it; a learned id that is not in the catalog is inert, since
the usage arm only ranks ids the registry defines.

On the runtime-event stream these events carry `origin: "external"`. Core invocation events have
no `origin` field, and adding one to an existing variant would break downstream literal
construction of `TraceEvent`, so the SDKs remember the invocation ids they minted for external
calls (bounded) and stamp `origin` as events leave the runtime-events layer. The local trace log
therefore does not carry it. No OTel span is opened for an external call; the framework owns
that, and the events join the caller's active trace instead.

### Adapters open turns by themselves

`@ratel-ai/vercel-ai-sdk` and `@ratel-ai/mastra` open one turn per agent call at their existing
recall points (`appendRecall` or step 0 of `prepareStep`; the Mastra recall processor), or join
the host's turn when one is active. Neither framework hands the adapter a context that spans the
call, and an `AsyncLocalStorage` scope entered inside `prepareStep` is lost after the first step,
so each adapter re-enters the turn around the tool executions it exposes using a key both sides
can see: the recall pair's call id or the last user message (AI SDK), and the generation's
`requestContext` object (Mastra). Tools the model runs outside Ratel's capability tools are
recorded through `recordToolCall` from the next step's hook, so a run's last step is not observed
and no duration is known. `captureUserMessage: true` sends the last user message on
`turn_start`; it is off by default. Both adapters feature-detect the turn surface, so against an
SDK older than this decision (the ADR-0020 peer floor) they behave as before.

The MCP integration is a client (`registerMcpServer`) with no request boundary of its own; its
upstream calls run through `invoke` and inherit whatever turn is active.

## Consequences

- One wrapper per request gives Cloud exact runs, end users, and the user's question, with no
  per-call plumbing; adapter users get turns with no code at all.
- Adaptive ranking gains multi-window attribution wherever a scope is active, which ADR-0014
  already defines as what supplying a `turn_id` buys.
- Adapter correlation is heuristic in one case: two concurrent AI SDK calls with no recall hits,
  the same last user message, and the same number of user messages share a turn.
- `origin: "external"` lives only on the runtime-event stream until core invocation events can
  carry it in a breaking release.

## Rejected

- **Per-call `turnId` only (the status quo):** correct, but almost no caller threads it.
- **A new event family for external calls:** Cloud already treats the invoke lifecycle as tool
  calls; a second vocabulary would split every consumer.
- **`AsyncLocalStorage.enterWith` from adapter hooks:** verified to lose the turn after the AI
  SDK's first step, and it leaks into the caller's context.
