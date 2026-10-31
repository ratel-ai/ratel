# `lib/contracts` (L0)

The ports: every capability that differs between the open-source and the Cloud edition is a type
declared here and implemented twice, in `lib/adapters/oss` and in the private checkout at
`ee/src`. The core reads ports only through `lib/composition/ports.ts`. This folder imports
nothing from the application.

`composition.ts` declares `CompositionPorts`, the full set a composition must supply; the private
side annotates against it, so the two shapes cannot drift.
