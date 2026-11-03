# `lib/contracts` (L0)

The ports: every capability that differs between the open-source and the Cloud edition is a type
declared here and implemented twice, in `lib/adapters/oss` and in the private checkout at
`ee/src`. The core reads ports only through `lib/composition/ports.ts`. This folder imports
nothing from the application.

`composition.ts` declares `CompositionPorts`, the full set a composition must supply; the private
side annotates against it, so the two shapes cannot drift.

A port grows additively, public first (ADR-0029): a new method lands here with its open-source
answer and the private adapter follows in its own pull request. The latest is
`entitlements.checkOrganizationDeletion`, whether an organization may be deleted now; the
open-source edition never refuses, an edition with billing refuses while a subscription is live.
