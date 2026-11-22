# RP-150 parity capture: the 6 Evals MCP tools, ratel-cloud vs ratel

- ratel-cloud: frozen main code at 1ce9942 (worktree ~/Dev/ratel-ai/ratel-cloud-rp149), harness parity/harness.ratel-cloud.ts
- ratel: branch beluga/rp-149-evals-tables at 846abb84, harness parity/harness.ratel.ts
- Same seed (one org, one project, the seat recording), same 19 calls, stand-in models, scripted spec filler. Normalized: uuids by first appearance, timestamps, ms timings (parity/normalize.py).

```console
$ python3 normalize.py ratel-cloud.json ratel.json
calls: 19 19 tools: ['change_eval', 'change_scorer', 'get_eval_run', 'list_evals', 'list_scorers', 'run_evals']
IDENTICAL
$ diff ratel-cloud.normalized.json ratel.normalized.json && echo no differences
no differences
```

| # | tool | answer |
|---|---|---|
| 1 | change_scorer | refused: invalid_params |
| 2 | change_scorer | ok |
| 3 | change_scorer | ok |
| 4 | change_scorer | ok |
| 5 | list_scorers | ok |
| 6 | list_scorers | ok |
| 7 | change_eval | ok |
| 8 | change_eval | ok |
| 9 | change_eval | ok |
| 10 | change_eval | ok |
| 11 | change_eval | refused: invalid_params |
| 12 | list_evals | ok |
| 13 | list_evals | ok |
| 14 | run_evals | ok |
| 15 | run_evals | ok |
| 16 | get_eval_run | ok |
| 17 | run_evals | ok |
| 18 | get_eval_run | ok |
| 19 | get_eval_run | refused: not_found |

## Tests (ratel src, tsx --test)
```console
ℹ tests 367
ℹ pass 367
ℹ fail 0
```
typecheck exit 0; lint exit 0; check:boundary, check:layers, check:private clean; sync --check in sync for views/evals, views/scorers, mcp/operations/evals, mcp/operations/loop.
