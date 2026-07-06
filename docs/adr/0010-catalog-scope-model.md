# 10. Catalog scope model: tenant → project → subject

Date: 2026-07-06

## Status

Proposed

Split out from [ADR-0003](0003-catalog-source-interface.md) (catalog source interface), which
records *that* the served catalog is scoped; this ADR records the scope model itself. Stays
Proposed until the managed cloud serves scoped catalogs against the `protocol/v1` conformance
vectors.

## Context

A networked catalog source ([ADR-0003](0003-catalog-source-interface.md)) serves a project's
published catalog. Two things the scope model must pin down: what a source API key authorizes,
and how one key serves many distinct end-users without a per-user credential. The dominant
deployment is one backend holding one key and multiplexing it across thousands of its own
end-users; a model that forced a key per end-user would break that shape.

## Decision

**Scope is a three-layer hierarchy: `tenant → project → subject`.**

- A **project Bearer key** authorizes `{tenant, project}`. That is the unit of authentication;
  the key scheme itself is [ADR-0003](0003-catalog-source-interface.md).
- The **`?scope=<subject>` selector** picks a subject layer within the authorized project. The
  served catalog is the subject layer **overlaid on the global (project) layer**: a skill in
  both layers is taken from the subject layer (**subject wins on name collision**), and the
  merged set is what the source returns and hashes into the ETag.
- **The selector is not itself authenticated.** A project key may name any subject under its
  project; the subject id is an application-level identifier the SDK passes through, not a
  credential. This is what lets one backend key serve thousands of its own end-users.
- **Absent `scope` ⇒ the global layer only**, byte-compatible with a source that has no notion
  of subjects (its global layer is the whole catalog).
- **The engine stays scope-blind.** Scope resolution happens entirely source-side; the SDK
  hydrates its registries from an already-resolved set and never reasons about layers.

### Confidential per-subject isolation (reserved)

Binding a key to a single subject — so it cannot read other subjects' layers — is a stronger
policy for multi-tenant resale where subjects must not see each other. It is a **deployment
policy, not a wire change**: it constrains which `?scope=` values a key may name and needs no
new shape. It is reserved, not adopted, because making it the default breaks the dominant
one-key-many-subjects shape.

## Consequences

- The `?scope=` selector is a **project-level boundary**, not a per-subject security boundary —
  stated rather than implied. A project key can read every subject layer under its project;
  applications that need hard per-subject isolation opt into the confidential policy above.
- This ADR owns the *model*; [`protocol/v1`](../../protocol/v1/README.md) owns the *bytes* —
  the `?scope=` parameter, the per-scope ETag / `If-None-Match` validity, and the overlay's
  effect on the hashed set are frozen there.
- A source with no subjects is conformant for free: it serves its global layer and ignores
  `?scope=`, staying byte-compatible with the absent-scope case.

## Rejected

- **Per-subject keys as the default:** breaks the one-backend-key-serving-many-end-users shape
  that dominates real usage; confidential isolation stays an opt-in policy instead.
- **Authenticating the `?scope=` selector:** forces a credential per subject and defeats the
  pass-through model; the project key already bounds what is reachable.
- **A flat `tenant → project` model (no subject layer):** pushes per-end-user catalog
  customization back into the application, which is the multiplexing the subject layer exists
  to remove.
