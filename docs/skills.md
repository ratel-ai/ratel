# Ratel skills suite

> One-line pointer to the Ratel skills suite for partner engagements.

The Ratel skills suite is a separate public repo: **[ratel-ai/skills](https://github.com/ratel-ai/skills)**.

Five Claude Code / Cursor / Codex skills built around partner-engagement work on AI agent codebases:

- [`ratel-assessment`](https://github.com/ratel-ai/skills/blob/main/skills/ratel-assessment/SKILL.md) — static audit + scorecard + "Where Ratel fits" report
- [`ratel-langfuse-instrument`](https://github.com/ratel-ai/skills/blob/main/skills/ratel-langfuse-instrument/SKILL.md) — file-by-file Langfuse observability plan
- [`ratel-langfuse-dashboards`](https://github.com/ratel-ai/skills/blob/main/skills/ratel-langfuse-dashboards/SKILL.md) — Ratel-value + agent-health dashboard specs
- [`ratel-integrate`](https://github.com/ratel-ai/skills/blob/main/skills/ratel-integrate/SKILL.md) — Ratel rollout plan with A/B test design
- [`ratel-langfuse-analyze`](https://github.com/ratel-ai/skills/blob/main/skills/ratel-langfuse-analyze/SKILL.md) — live-trace analysis with actionable findings

## Install

```bash
npx skills add ratel-ai/skills -y -g
```

The CLI is [Vercel Labs' `skills.sh`](https://github.com/vercel-labs/skills) — works with Claude Code, Cursor, Codex, OpenCode, Gemini CLI, and 40+ other coding agents.

## Engagement arc

```
ratel-assessment          → "here's what's weak; here's where Ratel fits"
        ↓
ratel-langfuse-instrument → "here's how to see what's happening"
        ↓
ratel-langfuse-dashboards → "here's what to put on the screens"
        ↓
ratel-integrate           → "here's how to roll Ratel out + A/B it"
        ↓
ratel-langfuse-analyze    → "here's what the data says after the rollout"
```

Each skill's "Recommended next steps" section names which sibling to run next based on what it found. The arc isn't forced — it's a conditional flow.

## Lead-prompt

The one-shot copy-paste prompt for partners (also in the main [README](../README.md#get-a-ratel-assessment-of-your-agent-in-60-seconds) and the [suite README](https://github.com/ratel-ai/skills#quickstart--copy-paste-this-into-your-coding-agent)):

```text
I want you to assess my agent codebase and produce a Ratel-flavored
report so we can see what's weak and where Ratel would help.

Step 1 — install the Ratel skills suite:

  npx skills add ratel-ai/skills -y -g

Step 2 — run the `ratel-assessment` skill on this repository. It
will produce a markdown report at `docs/ratel-assessment-<date>.md`
with a 10-dimension scorecard, evidence-backed findings, and a
"Where Ratel fits" section.

Once we've reviewed the report together, run the `ratel-integrate`
skill to produce a concrete rollout plan (integration mode, pilot
scope, A/B test design, Langfuse metrics) at
`docs/ratel-integrate.md`.

Show me the scorecard inline and link to the report file.
```

## License

Both the skills suite and Ratel core are MIT-licensed.
