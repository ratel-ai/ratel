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
job; its optional `registerSourceIds` names the source ids the importer stores runs under, which
the ledger and Agent health treat as imports (any other id is live telemetry). `imported-runs.ts` declares the decoded span structurally, so the edition never imports the
ingest types.

The optional `importRunning` port answers whether an import is storing runs for a project right
now, so an Agent health reading made meanwhile is marked early; the open-source edition has no
importer and leaves it out.

`CoreServices.onboarding` (`onboarding.ts`) is project creation for a page the edition owns, such
as Cloud's invitation page: `createFirstProject` takes a name, the organization and the person,
runs the core's own onboarding (name rules, the plan's project cap, the project, its first key,
the product events) and answers with the key once and the send-your-first-trace snippets as data;
`ensureSampleProject` gives an empty organization its sample project. The edition resolves the
session and refuses a support session before it calls either.

`self-telemetry.ts` holds the names both editions share for Ratel's own model calls as telemetry:
`MODEL_CALL_TRACER` (the tracer whose spans the self-telemetry export selects) and
`selfTelemetryProjectId` (the project those calls are not exported for). The core's model-call seam
and the edition's copy start their spans with it, and `platform/otel/ratel-export.ts` selects them.

`telemetry.ts` also carries the core's model calls to an edition that accounts for spend: the
optional `recordModelCall` takes each raw `ModelCallRecord` (ids, a model name, tokens, an outcome;
never a prompt or an answer) with the core's log context, and the edition writes and prices its own
line. The open-source edition leaves it out, and a recorded call only runs.

`mcpOAuth` (`mcp-oauth.ts`) is an optional port, not in the required set: browser sign-in for MCP
clients. The MCP endpoint hands a bearer that is not a project key to `verifyAccessToken`, which
answers with the person and their organizations, or says the token is invalid or belongs to
nobody with an account. Its optional `launchAccess` is the console's allowlist for a person by their provider id; the MCP server asks it for every signed-in caller and refuses without it. The open-source edition has no such port and accepts project keys only.

`EditionUi` (same file) holds the optional UI slots. Two relate to the organization: `OrganizationBillingPage`
fills `/org/<slug>/billing` (a 404 without it), and `hiddenOrganizationNav(slug)` returns the
edition organization-nav paths to hide for that organization. Both are absent in the open-source
edition, which is unchanged.

`HealthImports` puts an importer on the Agent health page: `load` reads a project's recent imports
(the page state reads them), `sourceLabel` names each source in the page's copy, and `Importer`
is mounted once (the list under a state block, or only the dialog the page menu opens with
`openHealthImport`). Without it the page offers no import.

`HealthShare` is Agent health's public share link. `load` reads a project's live link and whether
the reader may manage it (null when sharing is not offered to this reader); `Dialog` is mounted once on the page and opens from the page menu
(`openHealthShare`); `resolve` turns a public token into its link, project and organization, and
`recordView` counts a view. The two public pages (`/share/health/<token>` and its `/report`) are
the core's and show the redacted report; without the slot they answer 404 and the page offers no
sharing.

`ProjectPages` fills `/project/<id>/models/<key>` by key, `{ title, Page }`, with `Page` given the
project id and showing its own loading state; any other key is a 404. Its rail entries come from
`composition.projectNav`. The open-source edition has neither.
