# 1. Record architecture decisions

Date: 2026-04-29

## Status

Accepted

## Context

Ratel v1 reverses the v0 prototype's scope and architecture. The cross-cutting choices made along the way — server foundation, lib seam, transport, binding strategy, retrieval pipeline, and so on — need a durable, append-only record so that future contributors can find the *why* without spelunking through PR descriptions or chat history.

## Decision

We use Architecture Decision Records, as [described by Michael Nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions). Records live in `docs/adr/`, numbered sequentially (`NNNN-kebab-title.md`), with the structure: `Status`, `Context`, `Decision`, `Consequences`. The `.adr-dir` file at the repo root points tooling (e.g., [adr-tools](https://github.com/npryce/adr-tools)) at this directory.

Status values: `Proposed`, `Accepted`, `Superseded`. ADRs are immutable once Accepted — to change a decision, write a new ADR that supersedes the old one and update the old ADR's status accordingly.

## Consequences

- Decision history is greppable and reviewable in PRs.
- Cost of writing an ADR is low (a few paragraphs); cost of *not* writing one is re-litigating the decision when the next contributor doesn't know the constraints.
- This is the *meta-ADR*; subsequent ADRs codify actual architectural decisions and reference v1 plan sections (`docs/RATEL_V1_PLAN.md`) where the reasoning lives.
