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
/** What an edition adds to the console's UI. Loaded by the layouts, never at boot. */
export type EditionUi = {
  /** Wraps the whole app, in the root layout. */
  RootProvider: ComponentType<{ children: ReactNode }>;
  /** Menu items above the docs in the account menu. */
  AccountMenuItems: ComponentType;
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
