# Agent twins

A twin is a small file next to your agent code, such as `docs-agent.twin.ts`. It declares the params Ratel can change per run (model, prompt, tools, scalars) and a `run` function that calls your real entry function. Your code keeps the defaults.

Run it locally with `ratel twin run <id> --input in.json`, or connect it to the Ratel playground with `ratel dev`. Each tool runs in a mode: `real`, `fake` or `confirm`. Read-only tools run real by default; tools with a side effect are faked unless the twin file sets `allowReal: true`.
