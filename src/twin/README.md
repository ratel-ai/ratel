# `src/twin/`

Agent twins: a small file next to the agent code declares the params Ratel can change per run
(model, prompt, scalars) and a `run` function that calls the real code. The runner speaks
[`protocol/twin/v1`](../../protocol/twin/v1/README.md).

- [`ts/`](ts/README.md) — `@ratel-ai/twin`, the TypeScript SDK and the `ratel` CLI.
