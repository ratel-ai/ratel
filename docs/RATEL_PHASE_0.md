# Ratel — Phase 0 Plan

> **Goal:** scaffold the repo and lock all six §6 decisions before any product code lands.
> **Duration:** ~5 calendar days, 2 people half-time (~5 person-days of effort).
> **Predecessor:** [`RATEL_V1_PLAN.md`](./RATEL_V1_PLAN.md). This doc operationalizes its Phase 0 section.
> **Status:** working plan; revise as ADR research surfaces surprises.

## 1. Why Phase 0 exists

Phase 0 is *deliberately* zero functionality. The two cheapest ways to break a v1 plan are:
1. Start coding before the architectural seams are decided → rework or fork.
2. Start coding before the team agrees on what's in v1 → scope creep.

So Phase 0 produces three things, in order of importance:
- **Locked decisions** (12 ADRs) — every cross-cutting choice that would otherwise get re-litigated mid-Phase-1.
- **A repo that compiles + CI** — the chassis Phase 1 lands code into.
- **A README that says what Ratel is** — so the next person who finds the repo via the v0 archive understands the trajectory.

If we only achieve the first, Phase 1 can still start (the decisions unblock it). If we only achieve the second and third, Phase 1 will fork on day three.

## 2. Exit criteria (definition of done)

A Phase 0 PR series is mergeable when:

- [ ] All Phase 0 work landed on `revamp` (the working branch); `main` untouched. Cutover deferred to after Phase 7 — see Branching strategy in `RATEL_V1_PLAN.md`.
- [ ] `revamp` README explains Ratel positioning and v1 trajectory; will be promoted to `main` at the Phase 7 cutover.
- [ ] Cargo workspace exists at `core/Cargo.toml` with 4 empty crates (`ratel-core`, `ratel-server`, `ratel-mcp-server`, `ratel-cli`); `cargo build` and `cargo test` pass on empty crates.
- [ ] pnpm workspace exists; `@ratel-ai/sdk` package scaffolded; `pnpm build` + `pnpm typecheck` pass.
- [ ] CI runs on PR for both Rust and TS; green on the empty workspace.
- [ ] All 12 ADRs in `docs/adr/` (see §5); the 6 §6-decision ADRs are status **Accepted** with rationale grounded in research/spikes, not handwave.
- [ ] No production code (auth, tool selection, telemetry, server endpoints, SDK methods). Stubs that compile, nothing more.

## 3. Out of scope (explicitly)

- Any feature implementation (auth, tool selection, telemetry sinks, server, CLI, SDK methods).
- Performance work, hardening, encryption-at-rest implementation.
- Downstream integrations beyond a stub `mcp-server` crate.
- Detailed ranking signal design — that's Phase 6.
- Python SDK skeleton — Phase 5.
- Marketing site / domain — separate track.

If something feels useful but isn't on the exit-criteria list, **defer to Phase 1**. Phase 0 over-runs because people ship "while we're here" code.

## 4. Workstreams

The work splits into five tracks. A and B can run in parallel from day 1; D dominates the calendar.

### A. Branch hygiene (negligible, day 1)

We're already on the `revamp` branch — work continues there. **No branching ceremony in Phase 0.** The `revamp → main` cutover is deferred to end of Phase 7 (see Branching strategy in `RATEL_V1_PLAN.md`); until then, `main` stays untouched as the live v0 codebase.

All Phase 0 work — scaffolding, CI, ADRs, README — lands on `revamp` via PR or direct commit per team preference. Person A's day-1 budget freed by this (½ day) folds into starting workstream B earlier.

### B. Workspace scaffolding (1 day, 1 person, day 1–2)

Target tree (matches §3 of v1 plan):

```
ratel/
├── core/
│   ├── Cargo.toml                    # workspace root
│   ├── lib/
│   │   ├── Cargo.toml                # crate: ratel-core
│   │   └── src/lib.rs
│   └── server/
│       ├── Cargo.toml                # crate: ratel-server
│       └── src/main.rs
├── integrations/
│   ├── mcp-server/
│   │   ├── Cargo.toml                # crate: ratel-mcp-server
│   │   └── src/main.rs
│   └── cli/
│       ├── Cargo.toml                # crate: ratel-cli (binary alias: ratel)
│       └── src/main.rs
├── sdks/
│   ├── ts/
│   │   ├── package.json              # @ratel-ai/sdk
│   │   ├── tsconfig.json
│   │   └── src/index.ts
│   └── py/                           # placeholder; populated in Phase 5
│       └── README.md
├── docs/
│   ├── RATEL_V1_PLAN.md
│   ├── RATEL_PHASE_0.md
│   └── adr/
│       ├── 0001-record-architecture-decisions.md
│       └── ...
├── .github/workflows/
│   ├── rust.yml
│   └── ts.yml
├── pnpm-workspace.yaml
├── package.json
├── README.md
└── LICENSE
```

Each crate has one `pub fn placeholder()` so `cargo build` succeeds. Each TS package exports one symbol so `tsc --noEmit` succeeds. **No real implementation yet** — the goal is a green chassis.

Cargo workspace lives in `core/Cargo.toml` and lists members across `core/` and `integrations/`. The single workspace simplifies CI, deps, and Rust tooling.

### C. CI baseline (½ day, 1 person, day 2–3)

Two GitHub Actions workflows:

**`rust.yml`** — runs on PR + push to `main`:
- `cargo build --workspace`
- `cargo test --workspace`
- `cargo clippy --workspace -- -D warnings`
- `cargo fmt --check`

**`ts.yml`** — runs on PR + push to `main`:
- `pnpm install --frozen-lockfile`
- `pnpm -r build`
- `pnpm -r typecheck`
- Biome check (or whichever linter we pick — quick decision, not ADR-worthy)

Caching: rust-cache for cargo, pnpm cache for node_modules. Don't optimize beyond that in Phase 0.

### D. Decision-locking via ADRs (2–3 days calendar, both people, day 1–5)

This is the bulk of Phase 0. See §5 below for the full ADR list and §6 for research approach on the open decisions.

Use **adr-tools** convention (matches `CLAUDE.md` policy in this repo): `docs/adr/NNNN-kebab-title.md`, with `Status: Proposed | Accepted | Superseded`, `Context`, `Decision`, `Consequences`. ADR 0001 is the meta-ADR establishing the convention.

For ADRs that *capture* already-locked decisions (those reached during the v1 plan discussion), status is **Accepted** on creation. For ADRs that *lock open §6 decisions*, status starts **Proposed**, and only flips to **Accepted** after the research/spike completes and is reviewed.

### E. README + landing copy (½ day, 1 person, day 5)

Land `README.md` on `revamp` (it'll be promoted to `main` at the Phase 7 cutover). Three sections:

1. **What Ratel is** — pull from §1 of v1 plan: Context Engineering platform, v1 wedge = tool selection + auth, lib + server, MCP integration as one consumer.
2. **Status** — "v1 in active development on the `revamp` branch. The current `main` runs the prior prototype until cutover at end of Phase 7."
3. **Pointers** — link to `docs/RATEL_V1_PLAN.md`, `docs/RATEL_PHASE_0.md`, ADR index.

Skip everything that requires actual product to exist (install instructions, code samples, demo video). Those land at the end of Phase 2 and Phase 3.

## 5. ADR list

12 ADRs. Six capture decisions already made (Accepted on creation); six lock open §6 decisions (Proposed → Accepted via research/spike).

| #    | Title                                                | Captures                          | Research needed                                                | Initial status            |
| ---- | ---------------------------------------------------- | --------------------------------- | -------------------------------------------------------------- | ------------------------- |
| 0001 | Record architecture decisions                        | adr-tools convention itself       | None                                                           | Accepted                  |
| 0002 | V1 scope and trajectory                              | v1 plan §1, §4.1 non-goal         | None — captures discussion                                     | Accepted                  |
| 0003 | Storage + embedding foundation: Rust + SQLite + sqlite-vector + FTS5 + fastembed-rs | v1 plan §5 | Light: confirm sqlite-vector license + Rust loadable-extension distribution; confirm fastembed-rs supports the §6 #6 shortlist | Proposed → Accepted day 2 |
| 0004 | Lib architecture — Backend interface as the seam     | v1 plan §3                        | None — already locked                                          | Accepted                  |
| 0005 | Integrations naming                                  | v1 plan §3                        | None — already locked                                          | Accepted                  |
| 0006 | Catalog/config ownership: code as source of truth    | v1 plan §4.4                      | None — captures discussion                                     | Accepted                  |
| 0007 | Server transport (§6 #1)                             | locks §6 #1                       | Light: review MCP server transport patterns                    | Proposed → Accepted day 3 |
| 0008 | Tool selection — replace vs suggest (§6 #2)          | locks §6 #2                       | Light: audit tool-injection points in TS agent frameworks      | Proposed → Accepted day 4 |
| 0009 | Tool selection — retrieval method, embedding model + reranker (§6 #6) | locks §6 #6 | **Spike (1–2 days)**: BM25 vs hybrid eval; pick embedding model from local shortlist (BGE-small / MiniLM / GTE-small / jina) via fastembed-rs; OpenAI included as quality reference only (not shipping) | Proposed → Accepted day 5 |
| 0010 | TS↔Rust binding strategy (§6 #5)                     | locks §6 #5                       | **Spike (1 day)**: cold-start cost of NAPI vs WASM vs HTTP-only | Proposed → Accepted day 4 |
| 0011 | Auth storage encryption (§6 #3)                      | locks §6 #3                       | Light: confirm AEAD + deployment-provided key as v1 floor      | Proposed → Accepted day 2 |
| 0012 | RFC 8693 token exchange — v1 or v2 (§6 #4)           | locks §6 #4                       | Light: design-partner conversation                             | Proposed → Accepted day 3 |

Conventions:
- ADRs that capture v1 plan decisions don't re-argue the decision; they reference §X of the plan and codify it.
- ADRs that lock §6 open decisions explicitly state alternatives considered and the rationale for picking one.
- Each ADR ends with **Consequences** — what this decision makes easier and harder downstream.

## 6. Decision-locking detail (the six §6 ADRs)

This section says how to actually close each open decision, not just that it needs to be closed.

### 6.1 Server transport (ADR 0007)

**Question:** MCP-native + REST control plane, or pure REST/SSE?

**Approach:** half-day research. Read existing MCP server transport implementations (the spec is short). Decide based on: (a) does MCP-native let us push tool selection more elegantly than REST polling? (b) does the server need a REST control plane regardless for catalog/token CRUD? (c) operational cost of running both.

**Default position:** MCP-native + REST control plane. MCP-native is what `ratel-mcp-server` integration needs anyway; REST is needed for catalog/auth admin. Both can ship — they don't conflict.

**Acceptance gate:** ADR explicitly enumerates which surfaces speak which protocol.

### 6.2 Tool selection — replace vs suggest (ADR 0008)

**Question:** Does the lib *replace* the agent's tool list (more powerful, less compatible) or *suggest* a ranked subset (more compatible, less leverage)?

**Approach:** half-day audit. For each major TS agent framework (Vercel AI SDK, OpenAI Agents SDK, Anthropic SDK, LangChain), find where tools enter the model context. Assess:
- Can we cleanly replace the tool list before the model call?
- Or do we have to suggest, and trust the framework not to override us?
- Is "configurable per-framework" the honest answer?

**Default position:** configurable, with "replace" as the default for frameworks that allow it (cleaner story) and "suggest" as fallback. The lib should expose both modes.

**Acceptance gate:** ADR references specific framework integration points (file/symbol level) for the major frameworks, not handwave.

### 6.3 Auth storage encryption (ADR 0011)

**Question:** What's the v1 floor for token storage encryption?

**Approach:** light research — review what ContextForge and Enkrypt do, confirm AEAD (AES-GCM or ChaCha20-Poly1305) with a deployment-provided key meets enterprise floor without forcing a KMS dependency.

**Default position:** AEAD with deployment-provided 32-byte key, supplied via env var or vault adapter at server startup. No KMS in v1; KMS adapter ships in v1.1 if a design partner needs it.

**Acceptance gate:** ADR specifies the cipher, key length, key-rotation story (or explicit non-goal for v1), and the failure mode if the key is missing.

### 6.4 RFC 8693 token exchange — v1 or v2 (ADR 0012)

**Question:** Ship downscoped per-server token exchange in v1, or defer to v1.1?

**Approach:** primarily a scoping conversation, not technical research. Talk to one or two design partners about whether downscoped tokens are a hard requirement for them. If yes, ship; if no, defer.

**Default position:** defer to v1.1. RFC 8693 is non-trivial and v1's core wedge doesn't depend on it. Tier-2 enterprise competitors ship it; we'll catch up when a real user demands it.

**Acceptance gate:** ADR cites at least one design-partner conversation. "We don't need it yet" is a valid conclusion *if it comes from talking to someone*, not from internal preference.

### 6.5 TS↔Rust binding strategy (ADR 0010) — needs a real spike

**Question:** NAPI, WASM, FFI, or HTTP-only for the TS SDK calling `ratel-core`?

**Approach:** **1-day spike.** Build a minimal Rust function (e.g., a vector similarity computation) and wire it through each candidate binding. Measure:
- Cold-start cost (matters for the <50ms NFR in §4.4)
- Build complexity (CI minutes, tooling)
- Cross-platform story (macOS / Linux / Windows)
- Distribution story (npm publish flow)

Constraints:
- HTTP-only is the easiest but introduces a server-required floor we want to avoid for lib-only mode.
- WASM has solid cold-start and cross-platform but Rust→WASM has limitations (no threads, async story is awkward).
- NAPI is fast and natural for Node but requires native artifacts per platform.
- FFI is bare metal — likely too much maintenance.

**Default position (pre-spike):** NAPI for the TS SDK, with HTTP-only as a fallback when bindings can't be loaded (e.g., obscure platform). WASM as a future option if we hit NAPI distribution pain.

**Acceptance gate:** ADR cites measured numbers from the spike, not theoretical tradeoffs. If the measured cold-start budget for NAPI exceeds the <50ms NFR, the default flips.

### 6.6 Tool selection — retrieval method, embedding model + reranker (ADR 0009) — needs a real spike

**Question:** BM25 / vector / hybrid for stage 1; which local embedding model from the v1 shortlist; LLM-as-reranker / purpose-built reranker for stage 2; where does telemetry enter?

**Locked going in (per the v1 plan):** local embeddings only via fastembed-rs; bundled for binaries, lazy-downloaded by SDKs; no remote-API embedding option in v1; internal `Embedder` trait as the seam for future cloud.

**Approach:** **1–2 day spike** (expect closer to 2). Build a small evaluation harness:

1. **Tool corpus.** Take 50–100 tool definitions from real MCP servers (GitHub, Linear, filesystem, Slack, etc.). Each tool has name + description + parameter schema.
2. **Query set.** Generate 30–50 realistic agent queries with ground-truth "correct tool" labels. Mix specific keyword queries ("create github issue") and semantic queries ("help me file a bug report").
3. **Run the retrieval × embedding-model matrix.** BM25 over name+description (FTS5), vector over embeddings (sqlite-vector), hybrid (RRF or weighted sum). For the vector and hybrid runs, evaluate the local shortlist via fastembed-rs: BGE-small-en-v1.5, all-MiniLM-L6-v2, GTE-small, jina-embeddings-v2-small-en.
4. **Include OpenAI text-embedding-3-small as a quality reference only** — *not* a shipping option. Tells us how much recall we're trading by going local; informs future-cloud strategy.
5. **Measure recall@5 and recall@10** per (retrieval × embedding) cell, plus per-query embedding latency on a representative CPU container (no GPU). Latency matters: it's the runtime cost.
6. **Sanity-check rerankers** on the top-10 from the best stage-1 cell. LLM-as-reranker (Haiku-class model) vs Cohere Rerank or BGE-reranker. Measure win rate on borderline queries, not just recall.
7. **Verify sqlite-vector + fastembed-rs work for us.** As part of the spike: license terms acceptable for open-core, loadable from Rust via `rusqlite` (sqlite-vector) and via the `fastembed` crate, prebuilt binaries available for the CI matrix (macOS / Linux / Windows). If sqlite-vector is blocked → fall back to sqlite-vec. If fastembed-rs blocks our chosen model → fall back to Candle. This overlaps with ADR 0003's research and can be done jointly.

For "where does telemetry enter": this is harder to spike without real telemetry, so the ADR can lock the architecture (telemetry feeds in as score boost at stage 1 + as input to stage 2 reranker prompt) and defer parameter-tuning to Phase 6.

**Default position (pre-spike):** hybrid retrieval (FTS5 + sqlite-vector, RRF fusion) → small-LLM reranker (Haiku-class). Default embedding model: BGE-small-en-v1.5 (good size/quality balance, retrieval-specialized, well-supported in fastembed-rs). Telemetry enters as stage 1 score boost (cheap) and as a "preferences" signal in the stage 2 reranker prompt.

**Acceptance gate:** ADR cites recall@K numbers per (retrieval × embedding) cell + per-query CPU latency, not just "hybrid is better" or "BGE wins" handwave. Reranker choice can be lighter — tradeoff document is acceptable since we can revisit in Phase 6.

## 7. Suggested timeline (5 calendar days, 2 people half-time)

This is one viable sequencing, not the only one. The constraint is that workstream D dominates and can run alongside A/B/C.

| Day   | Person A (chassis)                       | Person B (decisions)                                    |
| ----- | ---------------------------------------- | ------------------------------------------------------- |
| Day 1 | Workspace scaffolding (workstream B, start) | Write ADRs 0001–0006 (the no-research ones)             |
| Day 2 | Workspace scaffolding (workstream B, finish) | ADR 0011 (auth encryption); kick off ADR 0007 research  |
| Day 3 | CI baseline (workstream C)               | Finalize ADR 0007 + 0012; start binding spike (ADR 0010) |
| Day 4 | Help with retrieval spike (ADR 0009)     | Finish binding spike → ADR 0010; start ADR 0008 audit   |
| Day 5 | README + landing copy (workstream E)     | Finalize ADRs 0008 + 0009; mark all six §6 ADRs Accepted |

Buffer: if the retrieval spike (0009) overruns, push to a 6th day. **Do not** start Phase 1 with 0009 still Proposed — Phase 1's tool-selection module depends on this decision.

## 8. Risks and what they cost

- **Retrieval spike overruns (likely).** Building the eval corpus + harness can take longer than 2 days if we discover that public MCP server tool descriptions are too sparse for meaningful eval. Mitigation: start the corpus on day 1 in parallel; supplement with synthetic tool descriptions if real ones are too thin. Cost if it overruns: 1–2 extra days at the start of Phase 1.
- **Binding spike reveals a worse-than-expected NAPI cold-start.** If NAPI blows the 50ms budget, we have to reopen WASM or HTTP-only. Cost: half a day of additional spike work, possible v1 plan revision (the binding choice ripples into Phase 2).
- **§6 #2 (replace vs suggest) discovers a framework that allows neither cleanly.** Some agent frameworks bake the tool list into the prompt template; "suggest" is the only honest mode for them. Cost: low — we land on "configurable, default per-framework" and document the matrix.
- **ADR review bandwidth.** With both people writing ADRs in parallel, peer review can become the bottleneck. Mitigation: review in batches, not one-by-one. Async review via PR comments works fine for most; hold a single sync review for the two spike-driven ADRs (0009, 0010).
- **Scope creep into Phase 1.** Once the chassis exists, the temptation to "just stub out auth real quick" is real. **Don't.** Phase 0 ends when the exit criteria in §2 are checked, not when one person feels ready.

## 9. Handoff to Phase 1

Phase 1 starts with:
- A green CI on an empty workspace, all on the `revamp` branch.
- 12 merged ADRs, 6 of them locking §6 decisions.
- A README on `revamp` that reflects v1 positioning (will be promoted to `main` at the Phase 7 cutover).
- `main` untouched, still running the v0 prototype.
- No production code to undo or rewrite.

Phase 1's first PR should be `core/lib`'s `Backend` trait + `LocalBackend` skeleton — the seam ADR 0004 codified.
