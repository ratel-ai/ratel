import type { ComponentType, ReactNode } from "react";
import type { EmbeddingProviderPort } from "@/lib/contracts/embedding-provider";
import type { EntitlementsPort } from "@/lib/contracts/entitlements";
import type {
  ImportedRunsPort,
  ImportSummary,
  ImportWindowOption,
} from "@/lib/contracts/imported-runs";
import type { RegistryPort } from "@/lib/contracts/registry";
import type { SessionPort } from "@/lib/contracts/session";
import type { TelemetryPort } from "@/lib/contracts/telemetry";
import type { ToolCorpusPort } from "@/lib/contracts/tool-corpus";

/**
 * The port set a composition supplies (ADR-0030). It lives among the contracts because both
 * sides of the boundary annotate against it: the core assembles one in `lib/composition/ports.ts`,
 * and the private modules in `ee/` declare one through the `#ee-composition` seam. The seam
 * resolves to a single candidate so the open-source build excludes the private modules, which
 * means this shared type is what keeps the two shapes from drifting.
 */
/** A project as the shell lists it: the session organization's, from the core. */
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

/**
 * What an edition adds to the console's UI. Loaded by the layouts, never at boot. Each optional
 * component replaces what the open-source console shows in its place, which is the default.
 */
export type EditionUi = {
  /** Wraps the whole app, in the root layout. */
  RootProvider: ComponentType<{ children: ReactNode }>;
  /** Menu items above the docs in the account menu. */
  AccountMenuItems: ComponentType;
  /** The top of the rail, in place of the project switcher: organizations and projects. */
  ScopeSwitcher?: ComponentType<{ projects: readonly EditionProject[]; collapsed: boolean }>;
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
};

/** What the core lends an edition: capabilities over core data that only the core implements. */
export type CoreServices = {
  toolCorpus: ToolCorpusPort;
  importedRuns: ImportedRunsPort;
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
};

export const PORT_NAMES = [
  "session",
  "entitlements",
  "telemetry",
  "embeddingProvider",
  "registry",
] as const satisfies readonly (keyof CompositionPorts)[];
