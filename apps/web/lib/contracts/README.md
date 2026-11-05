# `lib/contracts` (L0)

The ports: every capability that differs between the open-source and the Cloud edition is a type
declared here and implemented twice, in `lib/adapters/oss` and in the private checkout at
`ee/src`. The core reads ports only through `lib/composition/ports.ts`. This folder imports
nothing from the application.

`composition.ts` declares `CompositionPorts`, the full set a composition must supply; the private
side annotates against it, so the two shapes cannot drift.

`CoreServices` (same file) is the other direction: what only the core implements, lent to the
edition once at startup through the optional `connect`. It holds `toolCorpus`
(`tool-corpus.ts`), a project's tools with their searchable text resolved, which Cloud's Tool
Picker ranks.

`EditionUi` (same file) holds the optional UI slots. Two relate to the organization: `OrganizationBillingPage`
fills `/org/<slug>/billing` (a 404 without it), and `hiddenOrganizationNav(slug)` returns the
edition organization-nav paths to hide for that organization. Both are absent in the open-source
edition, which is unchanged.
