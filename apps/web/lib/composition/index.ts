import { eeComposition as seamEe } from "#ee-composition";
import { ossIdentity } from "@/lib/adapters/oss/identity";
import { ossWorkspace } from "@/lib/adapters/oss/workspace";
import type { CompositionPorts } from "@/lib/contracts/composition";
import type { IdentityPort } from "@/lib/contracts/identity";
import type { WorkspacePort } from "@/lib/contracts/workspace";

export type NavItem = {
  href: string;
  label: string;
};

export type Composition = {
  edition: string;
  identity: IdentityPort;
  workspace: WorkspacePort;
  nav: NavItem[];
};

const REQUIRED_PORTS = ["identity", "workspace"] as const;

const VALID_EDITIONS = "oss, cloud";

export type CreateCompositionOptions = {
  ports?: Partial<Pick<Composition, "identity" | "workspace">>;
  eeComposition?: CompositionPorts | null;
};

export function createComposition(
  editionKey: string,
  options?: CreateCompositionOptions,
): Composition {
  const ee = options != null && "eeComposition" in options ? options.eeComposition : seamEe;
  const overrides = options?.ports ?? {};

  let composition: {
    edition: string;
    identity: IdentityPort | undefined;
    workspace: WorkspacePort | undefined;
    nav: NavItem[];
  };

  if (editionKey === "oss") {
    composition = {
      edition: "Ratel OSS",
      identity: "identity" in overrides ? overrides.identity : ossIdentity,
      workspace: "workspace" in overrides ? overrides.workspace : ossWorkspace,
      nav: [],
    };
  } else if (editionKey === "cloud") {
    if (ee == null) {
      throw new Error(
        "RATEL_COMPOSITION=cloud was requested but this build excludes the commercial modules",
      );
    }
    composition = {
      edition: "Ratel Cloud",
      identity: "identity" in overrides ? overrides.identity : ee.identity,
      workspace: "workspace" in overrides ? overrides.workspace : ee.workspace,
      nav: [{ href: "/admin", label: "Admin" }],
    };
  } else {
    throw new Error(
      `RATEL_COMPOSITION has unknown value ${JSON.stringify(editionKey)}; valid values: ${VALID_EDITIONS}`,
    );
  }

  for (const port of REQUIRED_PORTS) {
    if (composition[port] == null) {
      throw new Error(`Composition is missing required port: ${port}`);
    }
  }

  return composition as Composition;
}

const editionKey = process.env.RATEL_COMPOSITION;
if (editionKey == null || editionKey === "") {
  throw new Error(`RATEL_COMPOSITION is unset; valid values: ${VALID_EDITIONS}`);
}

export const composition = createComposition(editionKey);

export type { CompositionPorts } from "@/lib/contracts/composition";
