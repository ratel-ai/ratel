# Docs agent with a sandbox

A small chat agent like Ratel Docs Ask AI, built with the Vercel AI SDK (v6) and AI Gateway. It
answers questions about Ratel from a bundled set of docs pages and opens support tickets. Its
sandbox, `docs-agent.sandbox.ts`, lets the Ratel playground (or the local `ratel` CLI) run the real
agent with a changed model, prompt, max steps or tools, one user turn per run.

| Tool | What it does | Hint | Default mode in a sandbox run |
|---|---|---|---|
| `searchDocs` | Searches the pages in `src/docs/` by keyword | `readOnly` | `real` |
| `readDoc` | Reads one page by slug | `readOnly` | `real` |
| `createTicket` | Writes a ticket to the SQLite file `.data/tickets.sqlite`, or to Postgres when `DATABASE_URL` is set | `sideEffect` | `fake` |

`createTicket` never runs real in a sandbox run: the sandbox file does not set `allowReal: true`, so
the runner refuses a run that asks for it.

The sandbox file also declares the image of a hosted instance: a `node:22-slim` base, `pnpm
install`, and a Postgres sidecar seeded from `db/seed.sql` with the tickets table. The sidecar
sets `DATABASE_URL`, so a hosted `createTicket` writes to Postgres. Locally there is no
`DATABASE_URL`, so tickets stay in the SQLite file.

## The DI change

The agent's config is one `defaults` object, and `reply` takes it as a parameter. Production
calls `reply(messages)` and gets the defaults through `resolveLocal`, which returns them unchanged
and stamps `ratel.sandbox.id` and `ratel.sandbox.config_hash` on the active span. The sandbox passes the
per-run params instead.

```ts
// src/agent.ts
export const docsDefaults = { model: "anthropic/claude-sonnet-5.5", system: SYSTEM, maxSteps: 5, tools };

export async function reply(
  messages: ModelMessage[],
  cfg: DocsConfig = resolveLocal(docsDefaults, { sandbox: "docs-agent" }), // was: module constants
  options: ReplyOptions = {},
): Promise<Reply> {
  const result = streamText({ model: cfg.model, system: cfg.system, messages, tools: cfg.tools,
    stopWhen: stepCountIs(cfg.maxSteps), experimental_telemetry: { isEnabled: true } });
  // ...
}
```

In production the model is the ID string, which the AI SDK sends through AI Gateway. In a sandbox
run it is a `LanguageModel` that the runner resolves: through AI Gateway when
`AI_GATEWAY_API_KEY` is set, else through an installed `@ai-sdk/<provider>` package and its key.

## The sandbox file

```ts
// docs-agent.sandbox.ts
export default sandbox("docs-agent", {
  params: {
    model: sandbox.model(docsDefaults.model),
    system: sandbox.prompt(docsDefaults.system),
    maxSteps: sandbox.int(docsDefaults.maxSteps, { min: 1, max: 10 }),
    tools: sandbox.tools(docsDefaults.tools, {
      searchDocs: { readOnly: true },
      readDoc: { readOnly: true },
      createTicket: { sideEffect: true }, // faked unless allowReal: true
    }),
  },
  input: aiSdkChat(), // run gets { messages }: the conversation so far
  resolve: aiSdkModels(),
  run: async ({ input, params, ctx }) =>
    (await reply(input.messages, params, { onText: ctx.textDelta, abortSignal: ctx.signal })).text,
});
```

## Run it

You need Node 22.13 or later (for `node:sqlite`) and a model: an AI Gateway key, or Amazon
Bedrock. For Bedrock, set `DOCS_AGENT_MODEL` to an `amazon-bedrock/<model id>` value. It
changes the code default, so the chat, the seed and the sandbox all use it, and the AWS credential
chain signs the calls.

```sh
export AI_GATEWAY_API_KEY=...   # the model, through AI Gateway
# or, through Amazon Bedrock with an AWS profile (SSO works):
export DOCS_AGENT_MODEL=amazon-bedrock/eu.anthropic.claude-haiku-5-5
export AWS_PROFILE=<your profile> AWS_REGION=eu-central-1

export RATEL_API_KEY=rtl_...    # optional: send traces to a Ratel project

# Chat in the terminal with the three tools.
pnpm --filter @ratel-ai/example-sandbox-docs-agent start

# One sandbox run of the last user turn in chat.json, createTicket faked.
cd examples/sandbox-docs-agent
pnpm ratel sandbox list
pnpm ratel sandbox run docs-agent --input chat.json --tool createTicket=fake
pnpm ratel sandbox run docs-agent --input chat.json --fake createTicket=ticket.json   # a fixed fake

# Prove that the model, the prompt and the tools reach the model call (--dry: no model call).
pnpm ratel sandbox verify docs-agent
pnpm ratel sandbox verify docs-agent --dry

# Connect the sandbox to the Ratel playground.
pnpm ratel sandbox dev
```

Use `pnpm ratel` (the workspace's `@ratel-ai/sandbox` bin): another `ratel` on your `PATH` is a
different CLI. In a local `sandbox run`, a fake comes from `--fake <tool>=<file.json>`, else a small
model generates it with your own key. A `confirm` tool has no reviewer in a local run, so it is
rejected.

## Seed sessions

`seed.ts` runs 20 scripted sessions of invented questions (no real user text) and sends them to
the Ratel project of `RATEL_API_KEY`: one `invoke_agent docs-agent` trace per user turn, with
message content and `gen_ai.conversation.id` on every span. Use a demo project. The playground can
replay these sessions.

```sh
AI_GATEWAY_API_KEY=... RATEL_API_KEY=rtl_... pnpm --filter @ratel-ai/example-sandbox-docs-agent seed
```

Seeded tickets go to `.data/tickets.sqlite` as well, since the seed runs the production agent. Set
`TICKETS_DB` to put them elsewhere.

## Test

```sh
pnpm --filter @ratel-ai/example-sandbox-docs-agent test
```

The test uses a scripted model, so it needs no key. It covers the production path (a real
ticket), the sandbox path (a faked ticket, the SQLite file unchanged), the refused `real` mode, the
config hash and the conversation ID on every span.
