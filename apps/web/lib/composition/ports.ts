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
  /** Other words ⌘K finds it by. */
  keywords?: readonly string[];
};

/** The rail's glyph keys; the console maps each to an icon. Declared here so an edition's nav can name one. */
export type NavIconName =
  | "overview"
  | "health"
  | "tasks"
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
  | "apis"
  | "edition";

/** An organization page an edition adds: `/org/<slug>/<path>`. */
export type OrganizationNavItem = {
  path: string;
  label: string;
  /** The rail glyph; the members one when absent. */
  icon?: NavIconName;
  /** The key after `g` that jumps here. */
  shortcut?: string;
  /** Other words ⌘K finds it by. */
  keywords?: readonly string[];
};

/** A project page an edition adds: `/project/<id>/<path>`. */
export type ProjectNavItem = {
  path: string;
  label: string;
  /** The rail glyph; the edition one when absent. */
  icon?: NavIconName;
  /** The key after `g` that jumps here. */
  shortcut?: string;
  /** Other words ⌘K finds it by. */
  keywords?: readonly string[];
};

/**
 * Where an edition's project group can sit as one row instead of a labelled section. `setup` is
 * the core's unlabelled group of Catalog and Settings; the row goes between the two.
 */
export type ProjectNavRow = {
  in: "setup";
  /** The row's glyph; the edition one when absent. */
  icon?: NavIconName;
  /** Other words ⌘K finds the row by. */
  keywords?: readonly string[];
};

/**
 * A named group of edition pages in the project rail: a labelled section between the core pages
 * and Settings, or, with `row`, one collapsible row in a core group whose sub-pages are its items.
 */
export type ProjectNavGroup = {
  id: string;
  label: string;
  items: ProjectNavItem[];
  /** Show the group as one collapsible row inside a core group, labelled `label`. */
  row?: ProjectNavRow;
};

export type Composition = CompositionPorts & {
  edition: string;
  /** The product's name where the shell has no project or organization to show. */
  productName: string;
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
  let productName: string;
  let nav: NavItem[];
  let organizationNav: OrganizationNavItem[] = [];
  let projectNav: ProjectNavGroup[] = [];

  if (editionKey === "oss") {
    base = OSS_PORTS;
    edition = "Ratel OSS";
    productName = "Ratel";
    nav = [];
  } else if (editionKey === "cloud") {
    if (ee == null) {
      throw new Error(
        "RATEL_COMPOSITION=cloud was requested but this build excludes the commercial modules",
      );
    }
    base = ee;
    edition = "Ratel Cloud";
    productName = "Ratel Cloud";
    // The admin console is reached from the account menu, for allowlisted admins only.
    nav = [];
    organizationNav = [
      {
        path: "team",
        label: "Members",
        icon: "members",
        shortcut: "m",
        keywords: ["team", "invite", "people"],
      },
      {
        path: "billing",
        label: "Billing",
        icon: "billing",
        shortcut: "b",
        keywords: ["plan", "credits", "invoices"],
      },
    ];
    // Upstream's one collapsible APIs row between Catalog and Settings (lib/navigation/v2.ts).
    projectNav = [
      {
        id: "apis",
        label: "APIs",
        row: { in: "setup", icon: "apis", keywords: ["hosted apis", "embeddings", "tool picker"] },
        items: [
          {
            path: "models/embeddings",
            label: "Embeddings",
            icon: "embeddings",
            shortcut: "e",
            keywords: ["vectors", "usage", "api"],
          },
          {
            path: "models/tool-picker",
            label: "Tool Picker",
            icon: "tool-picker",
            shortcut: "p",
            keywords: ["pick", "routing", "decision", "api"],
          },
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

  // The edition's own fields last: a ports object never overrides the edition's nav.
  return { ...(ports as CompositionPorts), edition, productName, nav, organizationNav, projectNav };
}

export const composition = createComposition(process.env.RATEL_COMPOSITION || "oss");

export type { CompositionPorts } from "@/lib/contracts/composition";
