import type { IdentityPort } from "@/lib/contracts/identity";
import type { WorkspacePort } from "@/lib/contracts/workspace";

/**
 * The port set a composition supplies. It lives among the contracts because both
 * sides of the boundary annotate against it: the core assembles one, and the
 * commercial modules in `ee/` declare one through the `#ee-composition` seam. The seam
 * resolves to a single candidate so the open-source build excludes the commercial
 * module, which means this shared type is what keeps the two shapes from drifting.
 */
export type CompositionPorts = {
  identity: IdentityPort;
  workspace: WorkspacePort;
};
