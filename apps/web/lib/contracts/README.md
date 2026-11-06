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
Picker ranks, and `importedRuns` (`imported-runs.ts`), which stores runs Cloud's Agent health
import read from another product as live ingest does, asks for a reading and queues the import's
job. `imported-runs.ts` declares the decoded span structurally, so the edition never imports the
ingest types.

`EditionUi` (same file) holds the optional UI slots. Two relate to the organization: `OrganizationBillingPage`
fills `/org/<slug>/billing` (a 404 without it), and `hiddenOrganizationNav(slug)` returns the
edition organization-nav paths to hide for that organization. Both are absent in the open-source
edition, which is unchanged.

`HealthImports` puts an importer on the Agent health page: `load` reads a project's recent imports
(the page state reads them), `sourceLabel` names each source in the page's copy, and `Importer`
is mounted once (the list under a state block, or only the dialog the page menu opens with
`openHealthImport`). Without it the page offers no import.

`ProjectPages` fills `/project/<id>/models/<key>` by key, `{ title, Page }`, with `Page` given the
project id and showing its own loading state; any other key is a 404. Its rail entries come from
`composition.projectNav`. The open-source edition has neither.
