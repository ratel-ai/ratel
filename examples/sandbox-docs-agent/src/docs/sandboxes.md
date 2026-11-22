# Agent sandboxes

A sandbox is a small file next to your agent code, such as `docs-agent.sandbox.ts`. It declares the params Ratel can change per run (model, prompt, tools, scalars) and a `run` function that calls your real entry function. Your code keeps the defaults.

Run it locally with `ratel sandbox run <id> --input in.json`, or connect it to the Ratel playground with `ratel sandbox dev`. Each tool runs in a mode: `real`, `fake` or `confirm`. Read-only tools run real by default; tools with a side effect are faked unless the sandbox file sets `allowReal: true`.
