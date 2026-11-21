# proof/rp-25: evidence for milestone "Ship better Agents and MCP servers pages"

This branch holds the review, the approved design, screenshots of the built pages next to the design, test and typecheck logs, and the parity capture. Each log starts with its date and the ratel / ratel-platform commit pair it ran on.

- **Commit pair:** ratel `41d82b21` (branch `beluga/rp-27-agents-mcp-core`) and ratel-platform `c4332a0` (branch `beluga/rp-25-ship-better-agents`). The logs ran on 2026-11-21 between 19:16 and 19:25 UTC.
- **Baseline:** the ratel branch starts at RP-15's `dcbfd184`, with `beluga/rp-12-manage-cloud-feature` (the flags port) merged in. Upstream is ratel-cloud frozen main `1ce9942f`.
- **Seed:** ratel-cloud `scripts/seed-coding-agent.mts`, project "Coding Agent" (`76f22cfc-78fb-8646-897f-12c2401c1746`): agents claude → Explore → Plan, and MCP servers beluga_board, context7 and slack. The data is synthetic.
- **Full suites:** not run here. The plan runs them once in its final step.

## 1. Review and approval

| File | What |
|---|---|
| `review/review-and-proposal.md` | The RP-25 UI/UX review: 17 problems and the proposal |
| `review/upstream/*.png` | The ratel-cloud pages at `1ce9942f`: Agents list (3 agents and 1 agent), agent detail (claude, Explore), MCP servers list, MCP server detail |
| `review/mocks/10–13-*.png`, `review/mocks/proposal.html` | The four proposal mocks and their HTML source |

- **Approval (RP-26):** on 2026-11-21 the owner approved the design as is. The owner chose:
  - fixed thresholds: an MCP server is failing at ≥ 50% errors and degraded at ≥ 5%, and an agent gets the error pill above 10%;
  - error text from spans is shown;
  - the pages stay under Traces in the nav.
- **Deviations (RP-85):** the owner accepted both.
  - There is no Clients button, because the core has no Clients page.
  - Errors show the span's `error.type`, not the full message, because the core does not store the status message.

## 2. Built pages next to the approved design

| File | What |
|---|---|
| `side-by-side/agents.png` | Mock 10 beside the built Agents list |
| `side-by-side/agent-detail.png` | Mock 11 beside the built agent detail |
| `side-by-side/mcp-servers.png` | Mock 12 beside the built MCP servers list |
| `side-by-side/mcp-server-detail.png` | Mock 13 beside the built MCP server detail |
| `built/01–04-*.png` | The four pages with `FF_AGENTS_PAGES=1` |
| `built/01b-agents-sorted-flat.png` | A column sort flattens the tree |
| `built/02b-agent-edit-menu.png` | The admin "Edit agent" menu |
| `built/05-flag-off-nav.png`, `built/05b-flag-off-agents-404.png` | Flag off: Traces has no sub-items, and the page is a 404 |
| `built/walkthrough.gif` | 10 s: Traces → Agents → claude → beluga_board → MCP servers |

The screenshots were taken on ratel `83912f9b`. Later commits changed what the pages compute but not how these screens look on this seed:

- `581eee14` counts a server seen from both sides once in the MCP totals. This seed has only one side per server.
- `41d82b21` decides the flag before the database check.

## 3. Logs

| File | What |
|---|---|
| `logs/overrides-api-and-store.log` | Agent overrides API, overrides rules, agents store and MCP-servers queries (pglite integration), paths, override controls, the flag |
| `logs/mcp-tools.log` | `list_agents`, `get_agent`, `list_mcp_servers`, `get_mcp_server`, the flag-off gate, and the contract, compatibility and account (get_flag_status) tests |
| `logs/pages.log` | Page-level flag test (flag off without a database gives 404, RP-83), context, nav and wiring flag tests, view models, page queries |
| `logs/cutover.log` | ratel-platform `db/cutover.integration.test.ts`: no drift, with core 0043 equal to upstream 0108 `agent_overrides` |
| `logs/cloud-flag-tests.log` | ratel-platform: `cloud-project-entities` decides `FF_AGENTS_PAGES` |
| `logs/typecheck-oss.log` | `pnpm --filter @ratel/platform typecheck` without `ee/src` (0 edition routes linked) |
| `logs/typecheck-cloud.log` | The same command with ratel-platform at `ee/src` (29 edition route files linked) |

## 4. Parity with ratel-cloud (RP-84)

| File | What |
|---|---|
| `parity/diff.txt` | Header: the revisions, seed, window and ignored fields (none). Each of the four tools reads IDENTICAL |
| `parity/upstream.json`, `parity/core.json` | The outputs of all four tools. Window 2026-11-19 to 2026-11-22, agent `claude`, server `beluga_board` |
| `parity/*.diff` | The `jq -S` diff for each tool. All four are empty |

The script that produced them is in ratel-platform: `scripts/agents-mcp-parity/run.sh` (commit `c4332a0`). Each side reads its own database:

- ratel-cloud reads its database migrated to 0110.
- The core reads its database migrated to 0043, which holds the same spans.
