# Port map: the 36 approved ratel-cloud 'port' PRs

Source list: `proof/phase-4` README (ratel-platform), Part 2, verdict **port**. Each row names the draft PR that ports it, or the reason why not. All PRs are drafts, stacked on ratel #387 (RP-130) above #384, and on ratel-platform #121 (cutover tool removal, retargeted onto #122 by owner decision) above #122 and #120. Flag-removal PRs sit on a side branch of their group and wait for the rollout.

| ratel-cloud PR | ratel PR | ratel-platform PR | Flag | Evidence |
|---|---|---|---|---|
| [#447](https://github.com/ratel-ai/ratel-cloud/pull/447) | [#407](https://github.com/ratel-ai/ratel/pull/407) | [#135](https://github.com/ratel-ai/ratel-platform/pull/135) | none: the US notice is true Cloud copy; core adds the EditionUi.embeddingsRegionNotice slot | [`rp-123-embeddings-notice/`](rp-123-embeddings-notice/) |
| [#478](https://github.com/ratel-ai/ratel-cloud/pull/478) | – | – | – | **Not ported here (reason):** config only, 3 lines in ratel-platform `deploy/values-prod.yaml` (Sage in prod). `deploy/` belongs to the RP-41 worktree in this plan; the change is handed to it (note on RP-41). The Sage code is already in ratel-platform (#81/#84). |
| [#480](https://github.com/ratel-ai/ratel-cloud/pull/480) | [#389](https://github.com/ratel-ai/ratel/pull/389) | [#123](https://github.com/ratel-ai/ratel-platform/pull/123) | none (log/span field fix; #559 in the same PR uses FF_INGEST_STRIP_CLIENT_ADDRESS) | [`rp-120/`](rp-120/) |
| [#507](https://github.com/ratel-ai/ratel-cloud/pull/507) | [#406](https://github.com/ratel-ai/ratel/pull/406) | [#134](https://github.com/ratel-ai/ratel-platform/pull/134) | FF_SHIP_MONITOR | [`rp-123-ship-monitor/`](rp-123-ship-monitor/) |
| [#519](https://github.com/ratel-ai/ratel-cloud/pull/519) | [#404](https://github.com/ratel-ai/ratel/pull/404) | [#132](https://github.com/ratel-ai/ratel-platform/pull/132) | FF_VARIANT_EXPERIMENTS | [`rp-123-variants/`](rp-123-variants/) |
| [#520](https://github.com/ratel-ai/ratel-cloud/pull/520) | [#402](https://github.com/ratel-ai/ratel/pull/402) | [#130](https://github.com/ratel-ai/ratel-platform/pull/130) | FF_CODE_HANDOFF | [`rp-140/`](rp-140/) |
| [#522](https://github.com/ratel-ai/ratel-cloud/pull/522) | [#398](https://github.com/ratel-ai/ratel/pull/398) | – (no Cloud change) | FF_AGENTS_PAGES | [`rp-138/`](rp-138/) |
| [#524](https://github.com/ratel-ai/ratel-cloud/pull/524) | [#400](https://github.com/ratel-ai/ratel/pull/400) | [#128](https://github.com/ratel-ai/ratel-platform/pull/128) | FF_PIVOTS, FF_CUSTOM_DASHBOARDS | [`rp-139/`](rp-139/) |
| [#526](https://github.com/ratel-ai/ratel-cloud/pull/526) | [#404](https://github.com/ratel-ai/ratel/pull/404) | [#132](https://github.com/ratel-ai/ratel-platform/pull/132) | FF_VARIANT_EXPERIMENTS | [`rp-123-variants/`](rp-123-variants/) |
| [#527](https://github.com/ratel-ai/ratel-cloud/pull/527) | [#398](https://github.com/ratel-ai/ratel/pull/398) | – (no Cloud change) | FF_AGENTS_PAGES | [`rp-138/`](rp-138/) |
| [#529](https://github.com/ratel-ai/ratel-cloud/pull/529) | [#399](https://github.com/ratel-ai/ratel/pull/399) | [#127](https://github.com/ratel-ai/ratel-platform/pull/127) | removes FF_AGENTS_PAGES | [`rp-138/`](rp-138/) |
| [#531](https://github.com/ratel-ai/ratel-cloud/pull/531) | [#402](https://github.com/ratel-ai/ratel/pull/402) | [#130](https://github.com/ratel-ai/ratel-platform/pull/130) | FF_CODE_HANDOFF | [`rp-140/`](rp-140/) |
| [#534](https://github.com/ratel-ai/ratel-cloud/pull/534) | [#402](https://github.com/ratel-ai/ratel/pull/402) | [#130](https://github.com/ratel-ai/ratel-platform/pull/130) | FF_CODE_HANDOFF | [`rp-140/`](rp-140/) |
| [#538](https://github.com/ratel-ai/ratel-cloud/pull/538) | [#400](https://github.com/ratel-ai/ratel/pull/400) | [#128](https://github.com/ratel-ai/ratel-platform/pull/128) | FF_PIVOTS, FF_CUSTOM_DASHBOARDS | [`rp-139/`](rp-139/) |
| [#539](https://github.com/ratel-ai/ratel-cloud/pull/539) | [#401](https://github.com/ratel-ai/ratel/pull/401) | [#129](https://github.com/ratel-ai/ratel-platform/pull/129) | removes FF_PIVOTS and FF_CUSTOM_DASHBOARDS | [`rp-139/`](rp-139/) |
| [#542](https://github.com/ratel-ai/ratel-cloud/pull/542) | [#400](https://github.com/ratel-ai/ratel/pull/400) | [#128](https://github.com/ratel-ai/ratel-platform/pull/128) | FF_PIVOTS, FF_CUSTOM_DASHBOARDS | [`rp-139/`](rp-139/) |
| [#543](https://github.com/ratel-ai/ratel-cloud/pull/543) | [#401](https://github.com/ratel-ai/ratel/pull/401) | [#129](https://github.com/ratel-ai/ratel-platform/pull/129) | removes FF_PIVOTS and FF_CUSTOM_DASHBOARDS | [`rp-139/`](rp-139/) |
| [#547](https://github.com/ratel-ai/ratel-cloud/pull/547) | [#403](https://github.com/ratel-ai/ratel/pull/403) | [#131](https://github.com/ratel-ai/ratel-platform/pull/131) | removes FF_CODE_HANDOFF | [`rp-140/`](rp-140/) |
| [#559](https://github.com/ratel-ai/ratel-cloud/pull/559) | [#389](https://github.com/ratel-ai/ratel/pull/389) | [#123](https://github.com/ratel-ai/ratel-platform/pull/123) | FF_INGEST_STRIP_CLIENT_ADDRESS | [`rp-120/`](rp-120/) |
| [#560](https://github.com/ratel-ai/ratel-cloud/pull/560) | [#398](https://github.com/ratel-ai/ratel/pull/398) | – (no Cloud change) | FF_AGENTS_PAGES | [`rp-138/`](rp-138/) |
| [#561](https://github.com/ratel-ai/ratel-cloud/pull/561) | [#405](https://github.com/ratel-ai/ratel/pull/405) | [#133](https://github.com/ratel-ai/ratel-platform/pull/133) | FF_FINE_TUNING | [`rp-141/`](rp-141/) |
| [#562](https://github.com/ratel-ai/ratel-cloud/pull/562) | [#397](https://github.com/ratel-ai/ratel/pull/397) (folded into one port from the #582 head) | [#126](https://github.com/ratel-ai/ratel-platform/pull/126) | FF_SANDBOXES | [`rp-122/`](rp-122/) |
| [#563](https://github.com/ratel-ai/ratel-cloud/pull/563) | [#405](https://github.com/ratel-ai/ratel/pull/405) | [#133](https://github.com/ratel-ai/ratel-platform/pull/133) | FF_FINE_TUNING | [`rp-141/`](rp-141/) |
| [#565](https://github.com/ratel-ai/ratel-cloud/pull/565) | [#397](https://github.com/ratel-ai/ratel/pull/397) (folded into one port from the #582 head) | [#126](https://github.com/ratel-ai/ratel-platform/pull/126) | FF_SANDBOXES | [`rp-122/`](rp-122/) |
| [#567](https://github.com/ratel-ai/ratel-cloud/pull/567) | [#405](https://github.com/ratel-ai/ratel/pull/405) | [#133](https://github.com/ratel-ai/ratel-platform/pull/133) | FF_FINE_TUNING | [`rp-141/`](rp-141/) |
| [#568](https://github.com/ratel-ai/ratel-cloud/pull/568) | [#397](https://github.com/ratel-ai/ratel/pull/397) (folded into one port from the #582 head) | [#126](https://github.com/ratel-ai/ratel-platform/pull/126) | FF_SANDBOXES | [`rp-122/`](rp-122/) |
| [#570](https://github.com/ratel-ai/ratel-cloud/pull/570) | [#390](https://github.com/ratel-ai/ratel/pull/390) | [#124](https://github.com/ratel-ai/ratel-platform/pull/124) | FF_TYPED_STEPS | [`rp-121/`](rp-121/) |
| [#571](https://github.com/ratel-ai/ratel-cloud/pull/571) | [#397](https://github.com/ratel-ai/ratel/pull/397) (folded into one port from the #582 head) | [#126](https://github.com/ratel-ai/ratel-platform/pull/126) | FF_SANDBOXES | [`rp-122/`](rp-122/) |
| [#572](https://github.com/ratel-ai/ratel-cloud/pull/572) | [#397](https://github.com/ratel-ai/ratel/pull/397) (folded into one port from the #582 head) | [#126](https://github.com/ratel-ai/ratel-platform/pull/126) | FF_SANDBOXES | [`rp-122/`](rp-122/) |
| [#575](https://github.com/ratel-ai/ratel-cloud/pull/575) | [#405](https://github.com/ratel-ai/ratel/pull/405) | [#133](https://github.com/ratel-ai/ratel-platform/pull/133) | FF_FINE_TUNING | [`rp-141/`](rp-141/) |
| [#576](https://github.com/ratel-ai/ratel-cloud/pull/576) | [#391](https://github.com/ratel-ai/ratel/pull/391) | – (no Cloud change) | FF_TYPED_STEPS | [`rp-121/`](rp-121/) |
| [#578](https://github.com/ratel-ai/ratel-cloud/pull/578) | [#392](https://github.com/ratel-ai/ratel/pull/392) | – (no Cloud change) | FF_TYPED_STEPS | [`rp-121/`](rp-121/) |
| [#579](https://github.com/ratel-ai/ratel-cloud/pull/579) | [#393](https://github.com/ratel-ai/ratel/pull/393) | – (no Cloud change) | FF_TYPED_STEPS | [`rp-121/`](rp-121/) |
| [#580](https://github.com/ratel-ai/ratel-cloud/pull/580) | [#396](https://github.com/ratel-ai/ratel/pull/396) | [#125](https://github.com/ratel-ai/ratel-platform/pull/125) | removes FF_TYPED_STEPS | [`rp-121/`](rp-121/) |
| [#581](https://github.com/ratel-ai/ratel-cloud/pull/581) | [#394](https://github.com/ratel-ai/ratel/pull/394) | – (no Cloud change) | FF_TYPED_STEPS | [`rp-121/`](rp-121/) |
| [#582](https://github.com/ratel-ai/ratel-cloud/pull/582) | [#397](https://github.com/ratel-ai/ratel/pull/397) (folded into one port from the #582 head) | [#126](https://github.com/ratel-ai/ratel-platform/pull/126) | FF_SANDBOXES | [`rp-122/`](rp-122/) |

## Stack (bottom to top)

| ratel PR | base | ratel-platform twin | base | ratel-cloud PRs |
|---|---|---|---|---|
| #389 `beluga/rp-120-port-small-fixes` | `rp-130-tool-run-insights-flag` | #123 | `rp-118-remove-cutover-tool` | #559, #480 |
| #390 `beluga/rp-121-typed-steps-570` | `beluga/rp-120-port-small-fixes` | #124 | `beluga/rp-120-port-small-fixes` | #570 |
| #391 `beluga/rp-121-typed-steps-576` | `beluga/rp-121-typed-steps-570` | – | `–` | #576 |
| #392 `beluga/rp-121-typed-steps-578` | `beluga/rp-121-typed-steps-576` | – | `–` | #578 |
| #393 `beluga/rp-121-typed-steps-579` | `beluga/rp-121-typed-steps-576` | – | `–` | #579 |
| #394 `beluga/rp-121-typed-steps-581` | `beluga/rp-121-typed-steps-579` | – | `–` | #581 |
| #395 `beluga/rp-121-typed-steps-all` | `beluga/rp-121-typed-steps-581` | – | `–` | integration (merges #578 into #581) |
| #396 `beluga/rp-121-typed-steps-580` | `beluga/rp-121-typed-steps-all` | #125 | `beluga/rp-121-typed-steps-570` | #580 |
| #397 `beluga/rp-122-sandboxes` | `beluga/rp-121-typed-steps-all` | #126 | `beluga/rp-121-typed-steps-570` | #562, #565, #568, #571, #572, #582 |
| #398 `beluga/rp-138-entities` | `beluga/rp-122-sandboxes` | – | `–` | #522, #527, #560 |
| #399 `beluga/rp-138-entities-529` | `beluga/rp-138-entities` | #127 | `beluga/rp-122-sandboxes` | #529 |
| #400 `beluga/rp-139-pivots` | `beluga/rp-138-entities` | #128 | `beluga/rp-122-sandboxes` | #524, #538, #542 |
| #401 `beluga/rp-139-pivots-flags` | `beluga/rp-139-pivots` | #129 | `beluga/rp-139-pivots` | #539, #543 |
| #402 `beluga/rp-140-code-handoff` | `beluga/rp-139-pivots` | #130 | `beluga/rp-139-pivots` | #520, #531, #534 |
| #403 `beluga/rp-140-code-handoff-547` | `beluga/rp-140-code-handoff` | #131 | `beluga/rp-140-code-handoff` | #547 |
| #404 `beluga/rp-123-variants` | `beluga/rp-140-code-handoff` | #132 | `beluga/rp-140-code-handoff` | #519, #526 |
| #405 `beluga/rp-141-fine-tuning` | `beluga/rp-123-variants` | #133 | `beluga/rp-123-variants` | #561, #563, #567, #575 |
| #406 `beluga/rp-123-ship-monitor` | `beluga/rp-141-fine-tuning` | #134 | `beluga/rp-141-fine-tuning` | #507 |
| #407 `beluga/rp-123-embeddings-notice` | `beluga/rp-123-ship-monitor` | #135 | `beluga/rp-123-ship-monitor` | #447 |

## Evidence in this branch

- `<group>/` real runs of the ported code (switch unset vs set) and `<group>/logs/` targeted test logs (RED before the port, GREEN after), sync reports and typecheck logs written while porting.
- `typecheck-top-oss.log`: `tsc --noEmit` on the top of the stack, open-source edition: exit 0.
- `prs/*.json`: `gh pr view` records of every new PR.
- `ci.md`: CI runs on the top of the stack.

## Owner decisions applied

- RP-119: the report's suggestions (e.g. #559 vs #522: read the country at ingest, then drop the IP).
- Gateway in `packages/gateway`; sandboxes paired with ratel #385 names and protocol v1; fine-tuning in core.
- Every new behavior is behind an `FF_*` switch, off by default; #480 (a log field fix) and #447 (true Cloud copy) have none.

## Deferred to the infra/deploy owners

PostHog flag declarations; GitHub App secrets and the webhook ALB rule (#520); `GEO_DB_MONTH` CI build arg (#522); the gateway's ECS service (#565); #478's prod values.
