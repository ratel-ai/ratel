import { eeComposition as seamEe } from "#ee-composition";
import { ossEmbeddingProvider } from "@/lib/adapters/oss/embedding-provider";
import { ossEntitlements } from "@/lib/adapters/oss/entitlements";
import { ossRegistry } from "@/lib/adapters/oss/registry";
import { ossSession } from "@/lib/adapters/oss/session";
import { ossTelemetry } from "@/lib/adapters/oss/telemetry";
import { type CompositionPorts, PORT_NAMES } from "@/lib/contracts/composition";

/**
 * The composition root for the ports (ADR-0030). It imports the contracts, the OSS adapters and
 * the `#ee-composition` seam, and nothing else, so any module may read it without a cycle. The
 * other root, `registry.ts`, collects every module's `register.ts` and is the one file allowed
 * to import upward.
 */
export type NavItem = {
  href: string;
  label: string;
};

/** The rail's glyph keys; the console maps each to an icon. Declared here so an edition's nav can name one. */
export type NavIconName =
  | "overview"
  | "health"
  | "intents"
  | "improvements"
  | "catalog"
  | "traces"
  | "settings"
  | "projects"
  | "integrations"
  | "members"
  | "billing"
  | "embeddings"
  | "tool-picker"
  | "ship"
  | "edition";

/** An organization page an edition adds: `/org/<slug>/<path>`. */
export type OrganizationNavItem = {
  path: string;
  label: string;
  /** The rail glyph; the members one when absent. */
  icon?: NavIconName;
};

/** A project page an edition adds: `/project/<id>/<path>`. */
export type ProjectNavItem = {
  path: string;
  label: string;
  /** The rail glyph; the edition one when absent. */
  icon?: NavIconName;
  /** The key after `g` that jumps here. */
  shortcut?: string;
};

/** A named group of edition pages in the project rail, between the core pages and Settings. */
export type ProjectNavGroup = {
  id: string;
  label: string;
  items: ProjectNavItem[];
};

export type Composition = CompositionPorts & {
  edition: string;
  nav: NavItem[];
  organizationNav: OrganizationNavItem[];
  projectNav: ProjectNavGroup[];
};

const VALID_EDITIONS = "oss, cloud";

export type CreateCompositionOptions = {
  ports?: Partial<CompositionPorts>;
  eeComposition?: CompositionPorts | null;
};

const OSS_PORTS: CompositionPorts = {
  session: ossSession,
  entitlements: ossEntitlements,
  telemetry: ossTelemetry,
  embeddingProvider: ossEmbeddingProvider,
  registry: ossRegistry,
};

export function createComposition(
  editionKey: string,
  options?: CreateCompositionOptions,
): Composition {
  const ee = options != null && "eeComposition" in options ? options.eeComposition : seamEe;
  const overrides = options?.ports ?? {};

  let base: CompositionPorts;
  let edition: string;
  let nav: NavItem[];
  let organizationNav: OrganizationNavItem[] = [];
  let projectNav: ProjectNavGroup[] = [];

  if (editionKey === "oss") {
    base = OSS_PORTS;
    edition = "Ratel OSS";
    nav = [];
  } else if (editionKey === "cloud") {
    if (ee == null) {
      throw new Error(
        "RATEL_COMPOSITION=cloud was requested but this build excludes the commercial modules",
      );
    }
    base = ee;
    edition = "Ratel Cloud";
    // The admin console is reached from the account menu, for allowlisted admins only.
    nav = [];
    organizationNav = [
      { path: "team", label: "Members", icon: "members" },
      { path: "billing", label: "Billing", icon: "billing" },
    ];
    projectNav = [
      {
        id: "apis",
        label: "APIs",
        items: [
          { path: "models/embeddings", label: "Embeddings", icon: "embeddings", shortcut: "e" },
          { path: "models/tool-picker", label: "Tool Picker", icon: "tool-picker", shortcut: "p" },
        ],
      },
    ];
  } else {
    throw new Error(
      `RATEL_COMPOSITION has unknown value ${JSON.stringify(editionKey)}; valid values: ${VALID_EDITIONS}`,
    );
  }

  const ports = { ...base } as Partial<CompositionPorts>;
  for (const port of PORT_NAMES) {
    if (port in overrides) (ports as Record<string, unknown>)[port] = overrides[port];
    if (ports[port] == null) throw new Error(`Composition is missing required port: ${port}`);
  }

  return { edition, nav, organizationNav, projectNav, ...(ports as CompositionPorts) };
}

export const composition = createComposition(process.env.RATEL_COMPOSITION || "oss");

export type { CompositionPorts } from "@/lib/contracts/composition";
