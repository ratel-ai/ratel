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

export type Composition = CompositionPorts & {
  edition: string;
  nav: NavItem[];
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
    nav = [{ href: "/admin", label: "Admin" }];
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

  return { edition, nav, ...(ports as CompositionPorts) };
}

export const composition = createComposition(process.env.RATEL_COMPOSITION || "oss");

export type { CompositionPorts } from "@/lib/contracts/composition";
