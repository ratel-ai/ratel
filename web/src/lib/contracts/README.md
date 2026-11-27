# `lib/contracts` (L0)

The ports: every capability that differs between the open-source and the Cloud edition is a type
declared here and implemented twice, in `lib/adapters/oss` and in the private checkout at
`ee/src`. The core reads ports only through `lib/composition/ports.ts`. This folder imports
nothing from the application.

`composition.ts` declares `CompositionPorts`, the full set a composition must supply; the private
side annotates against it, so the two shapes cannot drift. Its optional `productName` is how the
edition names the product in copy (`full` for the MCP server, `short` for the service in a
sentence); without it the copy keeps its neutral words.

`query.ts` is the query object: the one JSON contract of dashboards, alerts and MCP (a version, a kind
and what that kind asks; never the time window), with `parseQuery` and the `MEASURES` vocabulary.
Kind `sql` is RQL text (`text`, at most `MAX_SQL_TEXT` characters) with the RQL version it was
written in (`rqlVersion`, a whole number from 1); `synthesis/rql` checks the version and runs it.
`check.ts` is what a check reads and how it compares, for check scorers, funnel steps and evals. `views/dashboards/json-schemas.ts` derives the JSON Schemas under
`docs/schemas`.

`feature-flags.ts` names the core's switches by semantic key (`CORE_FLAGS`: `evalGate`,
`rankingCatalogDrift`, `mcpApps`, `agentsPages`, `toolRunInsights`, `focusedConsole`,
`customMonitoring`) and the optional
`featureFlags` port. The deployment's configuration (`web/src/config.ts`, `flags.<key>`) may
force each one on or off; only that file knows the environment variable of each. Without the port
each switch is its configured value for the deployment, off when unset (in the open-source
edition also `experimentalFeatures`). With it, the edition decides each switch per organization,
project and person; a forced value still comes first, and a failed read is off. The core reads switches through `featureEnabled` (`lib/platform/experimental-features.ts`),
and `get_flag_status` reports what it returns.

`entitlements.ts` is what an organization may have and use. Its optional `plans` is the plan
table of an edition that sells plans: the organization's plan and subscription state
(`summary`), the cheapest plan whose Agent health window reaches a number of days, the cheapest
that shows Agent health in full (optional, named by the locks), and a plan's name. The open-source edition leaves it out, so no plan is named and billing is never self-serve.

`usage-limits.ts` is the one seam for limits and usage: a caller checks a named limit, records what
it used with a reference, or reads a daily budget, and never sees a plan or a price. It holds the
hard limits. `usage-limits.contract.ts` is the test every adapter passes and
`usage-limits.fake.ts` the in-memory adapter for tests. The composition port is optional.
`sandbox-limits.ts` gives the configured limits of the deployment (`SANDBOX_*`), from which an
edition's adapter starts.

`sandbox-version-holds.ts` is the sandbox versions that another module still needs (the version
of a pinned eval baseline or of a running eval experiment), so the snapshot sweep of sandboxes
keeps their snapshots. Evals depend on sandboxes, so the composition root
(`lib/composition/registry.ts`) wires the evals answer into the sandboxes registration.

`eval-judge.ts` is the judge of evals: one yes or no question about a trial, with a reason from a
fixed list. The port supplies the model and says who pays. `eval-judge.contract.ts` is the test every
adapter passes. The composition port is optional.

`CoreServices` (`composition.ts`) is the other direction: what only the core implements, lent to the
edition once at startup through the optional `connect`. It holds `toolCorpus`
(`tool-corpus.ts`), a project's tools with their searchable text resolved, which Cloud's Tool
Picker ranks, `forgetOrganization`, what an edition calls before it deletes an organization, `forcedFlag`, the value the configuration forces for a core switch (an edition's
own flag reads apply it first, as `featureEnabled` does), and `importedRuns` (`imported-runs.ts`), which stores runs Cloud's Agent health
import read from another product as live ingest does, asks for a reading and queues the import's
job; its optional `registerSourceIds` names the source ids the importer stores runs under, which
the ledger and Agent health treat as imports (any other id is live telemetry). `imported-runs.ts` declares the decoded span structurally, so the edition never imports the
ingest types.

The optional `importRunning` port answers whether an import is storing runs for a project right
now, so an Agent health reading made meanwhile is marked early. The optional `runningImport`
names the running import with how many runs it has stored, for Agent health's "Importing
history" freshness line; the signal run asks it only when `importRunning` is absent. The
open-source edition has no importer and leaves both out.

`CoreServices.onboarding` (`onboarding.ts`) is project creation for a page the edition owns, such
as Cloud's invitation page: `createFirstProject` takes a name, the organization and the person,
runs the core's own onboarding (name rules, the plan's project cap, the project, its first key,
the product events) and answers with the key once and the send-your-first-trace snippets as data;
`ensureSampleProject` gives an empty organization its sample project. The edition resolves the
session and refuses a support session before it calls either.

The session port's optional `rememberProject` keeps the project a reader just opened, called by
the project layout once the reader may see it. Cloud keeps it on the user row and writes nothing in
a support session; the open-source edition leaves it out and keeps only the last-project cookie.
Its optional `lastProject` reads that pointer back: when the cookie names no project the reader may
see, `/project/_/…` links and the console entry land there, as Cloud's landing does. Without it they
land on the active organization's first project.
Its optional `tourStatus` (`TourStatusStore`) keeps how the signed-in person left the guided tour
with their account: Cloud reads and writes the user row and writes nothing in a support session.
Without it the core keeps the status in a per-browser cookie.
A project or organization page is authorized by the session's `memberships`, so any organization
the reader belongs to opens, whichever is active.

`self-telemetry.ts` holds the names both editions share for Ratel's own model calls as telemetry:
`MODEL_CALL_TRACER` (the tracer whose spans the self-telemetry export selects) and
`selfTelemetryProjectId` (the project those calls are not exported for). The core's model-call seam
and the edition's copy start their spans with it, and `platform/otel/ratel-export.ts` selects them.

`registry.ts` is what a module contributes to the background machinery (job handlers, drain
steps) and, from an edition only, `mcpOperations`: MCP tools over data only the edition holds
(Cloud's wallets and API usage). Each names its id, title, description, keywords, scope (project
or organization), loop stage and the core tool it is listed `after`, and its params without
`projectId`; the core adds that, resolves the project and publishes the tool read-only
(`lib/mcp/operations/edition.ts`). Its `execute` gets the project, its organization and the
core's `notFound`. The open-source edition registers none, so its tool list is unchanged.
A registration's optional `liveJobs` names running jobs it knows are alive however long they run
(Cloud's import with a fresh heartbeat); the stale-job reaper spares them.
`session.ts` also has the optional `supportSessionPresent`: whether the request carries a support-session marker at all, valid or not, since upstream refuses writes on the marker alone. And it carries `SUPPORT_BLOCKED_MESSAGE` and `isSupportBlockedError`, the message an edition's refused support-session write throws with, so the core's error page shows it as such instead of reporting a fault.

`telemetry.ts` also carries the core's model calls to an edition that accounts for spend: the
optional `recordModelCall` takes each raw `ModelCallRecord` (ids, a model name, tokens, an outcome;
never a prompt or an answer) with the core's log context, and the edition writes and prices its own
line. The open-source edition leaves it out, and a recorded call only runs.

`mcpOAuth` (`mcp-oauth.ts`) is an optional port, not in the required set: browser sign-in for MCP
clients. The MCP endpoint hands a bearer that is not a project key to `verifyAccessToken`, which
answers with the person and their organizations, or says the token is invalid or belongs to
nobody with an account. Its optional `launchAccess` is the console's allowlist for a person by their provider id; the MCP server asks it for every signed-in caller and refuses without it. The open-source edition has no such port and accepts project keys only.

`apiKeySecrets` (`api-key-secrets.ts`) is an optional port: an edition that keeps project API keys
for a later reveal. The core hands it every key it issues (`store`, after the key's row exists) and
its copy says "reveal it later" when `revealable()`; the reveal itself is on the edition's pages. The
open-source edition has none: keys are stored as hash and prefix only and shown once.

`trace-metering.ts` and `analysis-filter.ts` are optional ports with an open-source default, so
`composition.traceMetering` and `composition.analysisFilter` are always there. The first decides
each trace live ingest receives (`analyzed`, `ingested_only` or `dropped`); a metered organization
is not rejected by the monthly event cap. The second is the SQL condition that keeps the analysis
queries (the turn build, partial readings, the inferred tool share, match quality's searches) off
a trace that was not analyzed; they apply it through `platform/analysis-filter.ts`. The defaults
meter nothing and filter nothing.

`slackApp` (`slack-app.ts`) is an optional port: the Slack app of an edition that owns one for every
organization, or null while it has none. With it, organization settings show no Slack app fields. The
open-source edition has none: each organization saves its own app.

`EditionUi` (same file) holds the optional UI slots. Two relate to the organization: `OrganizationBillingPage`
fills `/org/<slug>/billing` (a 404 without it), and `hiddenOrganizationNav(slug)` returns the
edition organization-nav paths to hide for that organization. Both are absent in the open-source
edition, which is unchanged. `ProjectGeneralSettings` adds sections at the end of a project's
General settings.

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

`ConsoleOverlays` is mounted once in the console shell, after its dialogs (Cloud's feedback dialog
and diagnostics menu), and `commandActions` adds entries to the command palette, before the
console's own. An action is plain data (`EditionCommandAction`: id, label, keywords and a window
event name), so it crosses to the client; running it dispatches the event and the overlay answers.
Without them the shell renders as before.

The account menu takes two edition slots: `AccountMenuItems` above the docs and the keyboard
shortcuts, and the optional `AccountMenuEndItems` after them, so an edition can keep Cloud's order
(its profile and feedback first, its tools and sign-out last). Without `AccountMenuEndItems`
nothing follows the shortcuts.

`ProjectPages` fills `/project/<id>/models/<key>` by key, `{ title, Page }`, with `Page` given the
project id and showing its own loading state; any other key is a 404. `ProjectPageSkeleton` is
what the route shows while such a page loads, so the project Overview's skeleton never flashes
first. Its rail entries come from `composition.projectNav`. The open-source edition has none of them.

`linkPreview` gives the root layout the canonical origin and the words a shared link unfurls into
(`metadataBase`, OpenGraph, Twitter card); without it they name this deployment (`APP_NAME`,
`BASE_URL`). `OnboardingArt` replaces the first-run screen's backdrop and card emblem; without it
the static dot field and the badger mark stay. `accountNote` is a line under the name and email at
the top of the account menu (Cloud's "Local session (auth bypassed)").

`TelemetryPort` has two optional members for the edition's analytics. `reportRequestError` takes an
uncaught server-side request error with its request (path, method, headers) and route; the headers
are only for tying the error to the edition's own analytics identity and must never be logged.
`shutdown(timeoutMs)` flushes what the edition still buffers when the process stops. Without them
(the open-source edition) nothing is reported or flushed.

`client-analytics.ts` is the browser seam: an edition installs its `ClientAnalytics` (`track`,
`captureException`) with `installClientAnalytics`, and the core's `platform/track-client.ts`
forwards to it. Nothing is installed in the open-source edition, so the browser sends nothing.
It installs with the edition's provider, not before hydration: a root layout crash on a hard load
can happen first and then goes unreported.

`embedding-provider.ts` is the Playground's vectors. A provider that answered but was refused or
unreadable sets `reason` on the error it throws; its optional `noteUnavailable` is told when a
run wanted vectors with no key, so the edition can record the call it skipped.
