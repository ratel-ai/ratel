import { cloudIdentity } from "@/ee/identity";
import { cloudWorkspace } from "@/ee/workspace";
import { ossIdentity } from "@/lib/adapters/oss/identity";
import { ossWorkspace } from "@/lib/adapters/oss/workspace";
import type { IdentityPort } from "@/lib/contracts/identity";
import type { WorkspacePort } from "@/lib/contracts/workspace";

export type Composition = {
  edition: string;
  identity: IdentityPort;
  workspace: WorkspacePort;
};

const REQUIRED_PORTS = ["identity", "workspace"] as const;

const EDITIONS: Record<string, Composition> = {
  oss: {
    edition: "Ratel OSS",
    identity: ossIdentity,
    workspace: ossWorkspace,
  },
  cloud: {
    edition: "Ratel Cloud",
    identity: cloudIdentity,
    workspace: cloudWorkspace,
  },
};

const VALID_EDITIONS = Object.keys(EDITIONS).join(", ");

export function createComposition(
  editionKey: string,
  ports?: Partial<Pick<Composition, "identity" | "workspace">>,
): Composition {
  const preset = EDITIONS[editionKey];
  if (preset == null) {
    throw new Error(
      `RATEL_COMPOSITION has unknown value ${JSON.stringify(editionKey)}; valid values: ${VALID_EDITIONS}`,
    );
  }

  const overrides = ports ?? {};
  const composition = {
    edition: preset.edition,
    identity: "identity" in overrides ? overrides.identity : preset.identity,
    workspace: "workspace" in overrides ? overrides.workspace : preset.workspace,
  };

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
