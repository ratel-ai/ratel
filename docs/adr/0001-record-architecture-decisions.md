# 1. Keep a small, current set of ADRs

## Status

Accepted

## Context

Contributors and agents read the ADRs as context for every change. A record that describes
an old design, or a chain of records that supersede each other, costs each reader time and
leads them to wrong code.

## Decision

Record cross-cutting decisions as ADRs in `docs/adr/` (the `.adr-dir` file points tools
there). Name each file `NNNN-kebab-title.md`, with the next free number. Use the Nygard
sections: `Status`, `Context`, `Decision`, `Consequences`.

Each record states the decision as it is now:

- When the code drifts in a small way (a path, a name, a count), edit the record in place.
- When a decision changes, rewrite the record to state the new decision, or delete it when it
  no longer applies. Do not keep superseded records.
- When the set grows stale, merge, delete and renumber. Update every link in the repository.

`docs/adr/README.md` lists the records.

## Consequences

- A reader can trust that each record describes the system as it is.
- The history of a decision is in git (`git log -- docs/adr/`) and in pull requests, not in
  the records.
- A renumbering changes links: the pull request that renumbers fixes them all.
