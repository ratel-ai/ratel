# `src/sandbox/`

Agent sandboxes: a small file next to the agent code declares the params Ratel can change per run
(model, prompt, scalars) and a `run` function that calls the real code. The runner speaks
[`protocol/sandbox/v1`](../../protocol/sandbox/v1/README.md).

- [`ts/`](ts/README.md) — `@ratel-ai/sandbox`, the TypeScript SDK and the `ratel` CLI.
