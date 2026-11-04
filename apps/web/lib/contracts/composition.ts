import type { ComponentType, ReactNode } from "react";
import type { EmbeddingProviderPort } from "@/lib/contracts/embedding-provider";
import type { EntitlementsPort } from "@/lib/contracts/entitlements";
import type { RegistryPort } from "@/lib/contracts/registry";
import type { SessionPort } from "@/lib/contracts/session";
import type { TelemetryPort } from "@/lib/contracts/telemetry";

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
};

export type CompositionPorts = {
  session: SessionPort;
  entitlements: EntitlementsPort;
  telemetry: TelemetryPort;
  embeddingProvider: EmbeddingProviderPort;
  registry: RegistryPort;
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
