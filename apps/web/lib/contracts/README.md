# `lib/contracts` (L0)

The ports: every capability that differs between the open-source and the Cloud edition is a type
declared here and implemented twice, in `lib/adapters/oss` and in the private checkout at
`ee/src`. The core reads ports only through `lib/composition/ports.ts`. This folder imports
nothing from the application.

`composition.ts` declares `CompositionPorts`, the full set a composition must supply; the private
side annotates against it, so the two shapes cannot drift.

`EditionUi` (same file) holds the optional UI slots. Two relate to the organization: `OrganizationBillingPage`
fills `/org/<slug>/billing` (a 404 without it), and `hiddenOrganizationNav(slug)` returns the
edition organization-nav paths to hide for that organization. Both are absent in the open-source
edition, which is unchanged.

`ProjectPages` fills `/project/<id>/models/<key>` by key, `{ title, Page }`, with `Page` given the
project id and showing its own loading state; any other key is a 404. Its rail entries come from
`composition.projectNav`. The open-source edition has neither.
