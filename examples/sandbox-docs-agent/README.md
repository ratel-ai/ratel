# Docs agent with a sandbox

A small chat agent like Ratel Docs Ask AI, built with the Vercel AI SDK (v6) and AI Gateway. It
answers questions about Ratel from a bundled set of docs pages and opens support tickets. Its
sandbox, `docs-agent.sandbox.ts`, lets the Ratel playground (or the local `ratel` CLI) run the real
agent with a changed model, prompt or tools, one user turn per run.

| Tool | What it does | Hint | Default mode in a sandbox run |
|---|---|---|---|
| `searchDocs` | Searches the pages in `src/docs/` by keyword | `readOnlyHint` | `real` |
| `readDoc` | Reads one page by slug | `readOnlyHint` | `real` |
| `createTicket` | Writes a ticket to the SQLite file `.data/tickets.sqlite`, or to Postgres when `DATABASE_URL` is set | `destructiveHint` | `fake` |
| `summarizeDoc` (skill) | Loads the instructions to summarize one docs page | `readOnlyHint` | `real` |

`createTicket` never runs real in a sandbox run: a `destructiveHint` tool is faked by default and
has no `allowReal`, so the runner refuses a run that asks for it.

The sandbox file also declares the image of a hosted instance: a `node:22-slim` base, `pnpm
install`, and a Postgres sidecar seeded from `db/seed.sql` with the tickets table. The sidecar
sets `DATABASE_URL`, so a hosted `createTicket` writes to Postgres. Locally there is no
`DATABASE_URL`, so tickets stay in the SQLite file.

## The code: Ratel SDK tools and the catalog (experimental)

The agent reads its model and system prompt through the Ratel catalog
(`@ratel-ai/sdk/experimental/catalog`) and registers its tools on a Ratel core. MCP-style
`annotations` give each tool its default mode in a sandbox run: `readOnlyHint` runs real,
`destructiveHint` is faked, a tool with neither asks to confirm.

```ts
// src/agent.ts
export function docsConfig(): DocsConfig {
  return {
    model: catalog.model("model", docsModelId()),   // "provider/model"
    system: catalog.prompt("system", SYSTEM),        // the template
    maxSteps: MAX_STEPS,
    tools: { ...catalog.toolset(tools), ...skillTools() }, // the run's tools, one tool per skill
  };
}
const core = ratel().adaptTo(aiSdk());
await core.tools.register(tools);
await core.skills.register(skills);                  // summarizeDoc, offered via catalog.skills()
export const docsDefaults = docsConfig();            // read on load: the sandbox finds them
```

In production each call returns `ratel.catalog.json` values when that file exists, else the
defaults. In a sandbox run the same calls return the run's values. The model ID goes to AI Gateway,
or to Bedrock for an `amazon-bedrock/` ID (`src/bedrock.ts`).

## The sandbox file

No params block: the model, the prompt, the tools and the skill above are its params, with `source: "sdk"`
in the manifest. A param declared in the sandbox file would win on a name clash.

```ts
// docs-agent.sandbox.ts
export default sandbox("docs-agent", {
  input: aiSdkChat(), // run gets { messages }: the conversation so far
  image: sandbox.image({ /* the hosted instance, see above */ }),
  run: async ({ input, ctx }) =>
    (await reply(input.messages, undefined, { onText: ctx.textDelta, abortSignal: ctx.signal })).text,
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
pnpm ratel sandbox run docs-agent --input chat.json --set system="Answer in French."
pnpm ratel sandbox run docs-agent --input chat.json --dry   # stand-in model: shows the system prompt it got
pnpm ratel sandbox verify docs-agent --input chat.json
pnpm ratel sandbox verify docs-agent --input chat.json --dry

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
ticket), the catalog file, the sandbox path (a faked ticket, the SQLite file unchanged, a per-run
prompt), the refused `real` mode, `verify --dry` on the sdk params and the conversation ID on
every span.
