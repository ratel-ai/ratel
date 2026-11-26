import type { ComponentType, ReactNode } from "react";
import type { AnalysisFilterPort } from "@/lib/contracts/analysis-filter";
import type { ApiKeySecretsPort } from "@/lib/contracts/api-key-secrets";
import type { EmbeddingProviderPort } from "@/lib/contracts/embedding-provider";
import type { EntitlementsPort } from "@/lib/contracts/entitlements";
import type { CoreFlag, FeatureFlagsPort } from "@/lib/contracts/feature-flags";
import type {
  ImportedRunsPort,
  ImportSummary,
  ImportWindowOption,
} from "@/lib/contracts/imported-runs";
import type { McpOAuthPort } from "@/lib/contracts/mcp-oauth";
import type { OnboardingPort } from "@/lib/contracts/onboarding";
import type { RegistryPort } from "@/lib/contracts/registry";
import type { Organization, SessionPort } from "@/lib/contracts/session";
import type { SlackAppPort } from "@/lib/contracts/slack-app";
import type { TelemetryPort } from "@/lib/contracts/telemetry";
import type { ToolCorpusPort } from "@/lib/contracts/tool-corpus";
import type { TraceMeteringPort } from "@/lib/contracts/trace-metering";

/**
 * The port set a composition supplies (ADR-0004). It lives among the contracts because both
 * sides of the boundary annotate against it: the core assembles one in `lib/composition/ports.ts`,
 * and the private modules in `ee/` declare one through the `#ee-composition` seam. The seam
 * resolves to a single candidate so the open-source build excludes the private modules, which
 * means this shared type is what keeps the two shapes from drifting.
 */
/** A project as the shell lists it, from the core: one of any organization the reader belongs to. */
export type EditionProject = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  isDemo: boolean;
};

/** What the Agent health page hands an edition's importer. */
export type HealthImporterProps = {
  projectId: string;
  windowOptions: readonly ImportWindowOption[];
  initialImports: readonly ImportSummary[];
  /**
   * `history`: the list of imports and the dialog, under a state block that offers the import.
   * `dialog`: only the dialog, opened from the page menu (`openHealthImport`).
   */
  variant: "history" | "dialog";
  contactUrl: string | null;
  /** A reading is being built right now from imported runs. */
  readingBuilding: boolean;
};

/** A project's live public share link, as the member's dialog shows it. */
export type HealthShareLink = {
  token: string;
  windowDays: number;
  createdAt: string;
  viewCount: number;
  lastViewedAt: string | null;
};

/** What the Agent health page hands an edition's share dialog. */
export type HealthShareProps = {
  projectId: string;
  /** The window the page shows now; a new link opens on it. */
  windowDays: number;
  /** The live link, or null when sharing is off. */
  initialLink: HealthShareLink | null;
  /** Whether this reader may turn the link on or off. */
  canManage: boolean;
};

/** What a live public token opens: the link, its project and the project's organization. */
export type SharedHealthLink = {
  linkId: string;
  /** The window chosen when the link was made. */
  windowDays: number;
  project: { id: string; name: string };
  /** The edition may pass its wider row: the entitlements port reads the plan from it. */
  organization: Organization;
};

/**
 * An entry an edition adds to the command palette. Running it dispatches `event` on `window`; the
 * edition's overlay (`EditionUi.ConsoleOverlays`) listens for it. Plain data, so it crosses from
 * the server to the client.
 */
export type EditionCommandAction = {
  id: string;
  label: string;
  keywords?: readonly string[];
  event: string;
};

/**
 * How a shared link to the app previews (OpenGraph, Twitter card): the canonical origin and the
 * words a chat or social card shows.
 */
export type LinkPreview = {
  /** The public origin, e.g. `https://app.example.com`: the base for metadata URLs. */
  origin: string;
  siteName: string;
  title: string;
  description: string;
};

/**
 * What an edition adds to the console's UI. Loaded by the layouts, never at boot. Each optional
 * component replaces what the open-source console shows in its place, which is the default.
 */
export type EditionUi = {
  /** Wraps the whole app, in the root layout. */
  RootProvider: ComponentType<{ children: ReactNode }>;
  /**
   * The link preview, read per request by the root layout. Absent, it names this deployment
   * (`APP_NAME`, `BASE_URL`).
   */
  linkPreview?: () => LinkPreview;
  /** Menu items above the docs in the account menu. */
  AccountMenuItems: ComponentType;
  /**
   * Menu items after the keyboard shortcuts, at the foot of the account menu: the edition's tools
   * and its sign-out. Nothing follows the shortcuts without it.
   */
  AccountMenuEndItems?: ComponentType;
  /**
   * The top of the rail, in place of the project switcher: organizations and projects. Given the
   * projects of every organization the reader belongs to.
   */
  ScopeSwitcher?: ComponentType<{ projects: readonly EditionProject[]; collapsed: boolean }>;
  /**
   * The first-run screen's art (`/onboarding`): the badge heading its naming step. Without it,
   * the mark. The key-issued step draws the core's own illustration.
   */
  OnboardingArt?: {
    /**
     * No longer drawn (RTL-371): the core's backdrop shows in every edition. Kept optional so an
     * edition that still supplies one compiles.
     * @deprecated
     */
    Backdrop?: ComponentType;
    Emblem: ComponentType<{ tone?: "coral" | "mint" }>;
  };
  /**
   * A short line under the signed-in person's name and email at the top of the account menu (Cloud:
   * "Local session (auth bypassed)" under its local sign-in bypass), or null for none.
   */
  accountNote?: () => Promise<string | null>;
  /** `/organizations`, which otherwise redirects to the console's entry. */
  OrganizationsPage?: ComponentType;
  /** `/org/<slug>/team`, a 404 otherwise. */
  MembersPage?: ComponentType<{ slug: string }>;
  /** `/org/<slug>/billing`, a 404 otherwise. */
  OrganizationBillingPage?: ComponentType<{
    slug: string;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }>;
  /**
   * Edition organization-nav paths to hide for one organization (`composition.organizationNav`
   * entries by `path`), by slug. Nothing is hidden when absent.
   */
  hiddenOrganizationNav?: (slug: string) => Promise<readonly string[]>;
  /**
   * Project pages at `/project/<id>/models/<key>`, by key; any other key is a 404. Each page shows
   * its own loading state.
   */
  ProjectPages?: Readonly<
    Record<string, { title: string; Page: ComponentType<{ projectId: string }> }>
  >;
  /**
   * What `/project/<id>/models/<key>` shows while an edition project page loads, in place of the
   * project Overview's skeleton (the nearest loading state otherwise). Nothing without it.
   */
  ProjectPageSkeleton?: ComponentType;
  /** Project settings > General, under the core's own sections (Cloud: analysis sampling). */
  ProjectGeneralSettings?: ComponentType<{ projectId: string }>;
  /** Organization settings > General, read-only otherwise. */
  OrganizationGeneralSettings?: ComponentType<{ slug: string }>;
  /** Organization settings > Danger zone, absent otherwise. */
  OrganizationDangerSettings?: ComponentType<{ slug: string }>;
  /**
   * A bar above the whole console, absent otherwise (Cloud's admin support session). It may set
   * `--support-bar` on `:root` to its height; the shell's sticky parts sit below it.
   */
  ConsoleBanner?: ComponentType;
  /**
   * Wraps each console page inside the shell, absent otherwise. Cloud catches a write refused in
   * an admin support session here, so the page and the banner stay on screen.
   */
  ConsoleBoundary?: ComponentType<{ children: ReactNode }>;
  /**
   * Mounted once in the console shell, after the page and its dialogs, absent otherwise (Cloud's
   * feedback dialog and diagnostics menu). It opens on the window events its command actions and
   * account menu items dispatch.
   */
  ConsoleOverlays?: ComponentType;
  /** Entries the edition adds to the command palette, before the console's own; none otherwise. */
  commandActions?: readonly EditionCommandAction[];
  /** `/`, in place of the console's entry redirect. */
  RootPage?: ComponentType;
  /**
   * Wraps the console shell and the first-run screen, absent otherwise. It renders before the
   * shell resolves its data, so it may show something else instead (Cloud's waitlist).
   */
  ConsoleAccessGate?: ComponentType<{ children: ReactNode }>;
  /**
   * Agent health's importer (past runs read from another product), absent otherwise: the page
   * then offers no import and reads `imports: []`.
   */
  HealthImports?: {
    /** The project's recent imports, and where a customer whose import is held can book time. */
    load(projectId: string): Promise<{ list: readonly ImportSummary[]; contactUrl: string | null }>;
    /** How the page's copy names each import source, by source id. */
    sourceLabel: Readonly<Record<string, string>>;
    Importer: ComponentType<HealthImporterProps>;
  };
  /**
   * Public share links for Agent health, absent otherwise: the page then offers no sharing and
   * `/share/health/<token>` answers 404. The link, its token and who may manage it are the
   * edition's; the public pages and the redacted report they show are the core's.
   */
  HealthShare?: {
    /**
     * The project's live link, and whether the signed-in reader may manage it. Null when sharing
     * must not be offered to this reader (Cloud: inside an admin support session).
     */
    load(projectId: string): Promise<{ link: HealthShareLink | null; canManage: boolean } | null>;
    /** Mounted once on the page; it opens when the page menu asks (`openHealthShare`). */
    Dialog: ComponentType<HealthShareProps>;
    /** The live link behind a token; null for malformed, unknown and revoked tokens alike. */
    resolve(token: string): Promise<SharedHealthLink | null>;
    /** Counts one view of the public page. */
    recordView(linkId: string): Promise<void>;
  };
};

/** What the core lends an edition: capabilities over core data that only the core implements. */
export type CoreServices = {
  toolCorpus: ToolCorpusPort;
  importedRuns: ImportedRunsPort;
  /**
   * Project creation for a page the edition owns. Optional so an edition built against an older
   * core still type-checks; the core always lends it.
   */
  onboarding?: OnboardingPort;
  /**
   * The value the deployment's configuration forces for a core switch, or undefined. An edition's
   * own flag reads (a diagnostics view) apply it first, as `featureEnabled` does. Optional so an
   * edition built against an older core still type-checks; the core always lends it.
   */
  forcedFlag?: (flag: CoreFlag) => boolean | undefined;
  /**
   * Removes what the core keeps of an organization outside its projects: its Slack workspace, whose
   * token Slack is asked to end, and its Slack app. Call it before the organization is deleted; it
   * may run again. Optional so an edition built against an older core still type-checks; the core
   * always lends it.
   */
  forgetOrganization?: (organizationId: string) => Promise<void>;
};

export type CompositionPorts = {
  session: SessionPort;
  entitlements: EntitlementsPort;
  telemetry: TelemetryPort;
  embeddingProvider: EmbeddingProviderPort;
  registry: RegistryPort;
  /**
   * Absent in the open-source edition. The core calls it once at startup, before the first
   * request, with what only the core implements.
   */
  connect?: (core: CoreServices) => void;
  /** Absent in the open-source edition. A loader, so the boot path never imports the UI. */
  ui?: () => Promise<EditionUi>;
  /**
   * Whether an import of past runs is storing runs for the project right now; an Agent health
   * reading made meanwhile is marked early. Absent in the open-source edition, which has no
   * importer, so no import is ever running.
   */
  importRunning?: (projectId: string) => Promise<boolean>;
  /**
   * The import of past runs storing runs for the project right now, with how many it has stored
   * so far (the newest, when several run); null when none is. Agent health's freshness line says
   * "Importing history" from it, and the core prefers it to `importRunning`. Absent in the
   * open-source edition, which has no importer.
   */
  runningImport?: (projectId: string) => Promise<{ runsImported: number } | null>;
  /**
   * Absent in the open-source edition, where the MCP endpoint takes project API keys only. With
   * it, an MCP client may sign in through a browser and send the identity provider's token.
   */
  mcpOAuth?: McpOAuthPort;
  /**
   * Absent in the open-source edition, where a key is stored as hash and prefix only and shown
   * once. With it, the core hands every key it issues to the edition, which keeps it (sealed) for
   * a later reveal on its own pages, and the core's copy says the key can be revealed later.
   */
  apiKeySecrets?: ApiKeySecretsPort;
  /**
   * How the edition names the product in copy. `full` opens the MCP server's instructions and,
   * as a slug, names the server and its 401 realm ("Ratel", `ratel`); `short` is the
   * service doing the work in a sentence ("Ratel builds one once searches arrive", "Ratel
   * override"). Absent in the open-source edition, whose copy keeps its neutral words ("Ratel",
   * `APP_NAME`).
   */
  productName?: { full: string; short: string };
  /**
   * Absent in the open-source edition, where each core switch is its configured value
   * (`flags.<key>` in `web/src/config.ts`, or `experimentalFeatures`) for the whole deployment.
   * With it, the edition decides each switch per organization, project and person; a value the
   * configuration forces still comes first. Read through `featureEnabled` (`lib/platform/experimental-features.ts`).
   */
  featureFlags?: FeatureFlagsPort;
  /**
   * What happens to each trace live ingest receives. Absent, the composition uses the open-source
   * default: nothing is metered and every trace is analyzed.
   */
  traceMetering?: TraceMeteringPort;
  /**
   * What keeps analysis off a trace that was stored but not analyzed. Absent, the composition uses
   * the open-source default: no filter.
   */
  analysisFilter?: AnalysisFilterPort;
  /**
   * Absent in the open-source edition, where an organization saves its own Slack app in its
   * settings. With it, the edition supplies the app and the settings show no app fields.
   */
  slackApp?: SlackAppPort;
};

export const PORT_NAMES = [
  "session",
  "entitlements",
  "telemetry",
  "embeddingProvider",
  "registry",
] as const satisfies readonly (keyof CompositionPorts)[];
