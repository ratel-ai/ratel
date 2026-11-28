import { createHash } from "node:crypto";
import { type Config, getConfig } from "@/config";
import { getLogger } from "@/lib/platform/logger";
import type { SandboxProvider } from "../ports/sandbox-provider";
import { createBoatProvider } from "./boat-provider";
import { createLocalDockerProvider } from "./local-docker-provider";

type SandboxConfig = Pick<Config, "sandboxes" | "app">;

/** The provider that the configuration picks. `refused`: a provider that must not run here. */
export type ProviderKind =
  | { kind: "boat" }
  | { kind: "local-docker" }
  | { kind: "none" }
  | { kind: "refused"; reason: string };

const providers = new Map<string, SandboxProvider>();
const logger = getLogger("sandboxes/provider-from-env");
let refusalLogged = false;

/** Whether the provider is set up in the configuration. It makes no call. */
export function sandboxProviderConfigured(
  config: SandboxConfig = getConfig(),
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  const { kind } = sandboxProviderKind(config, nodeEnv);
  return kind === "boat" || kind === "local-docker";
}

/** The provider, or null when it is not set up or is refused. It makes no call. */
export function sandboxProvider(
  config: SandboxConfig = getConfig(),
  nodeEnv: string | undefined = process.env.NODE_ENV,
): SandboxProvider | null {
  const picked = sandboxProviderKind(config, nodeEnv);
  if (picked.kind === "refused") {
    if (!refusalLogged) logger.error({ reason: picked.reason }, "sandbox provider refused");
    refusalLogged = true;
    return null;
  }
  if (picked.kind === "none") return null;
  const deploymentId = sandboxDeploymentId(config);
  const { boatApiKey: apiKey, boatApiUrl: baseUrl, boatVmType: vmType } = config.sandboxes;
  const key = JSON.stringify([picked.kind, apiKey, baseUrl, vmType, deploymentId]);
  const known = providers.get(key);
  if (known) return known;
  const provider =
    picked.kind === "local-docker"
      ? createLocalDockerProvider({ deploymentId })
      : createBoatProvider({ apiKey: apiKey ?? "", baseUrl, vmType, deploymentId });
  providers.set(key, provider);
  return provider;
}

/**
 * The provider of `SANDBOX_PROVIDER`, else boat when `BOAT_API_KEY` is set. The local Docker
 * provider gives root on the host daemon and no VM isolation, so it is refused when `NODE_ENV` is
 * `production` and in the Cloud composition.
 */
export function sandboxProviderKind(
  config: SandboxConfig,
  nodeEnv: string | undefined,
): ProviderKind {
  const { provider, boatApiKey } = config.sandboxes;
  if (provider === "local-docker") {
    if (nodeEnv === "production") {
      return {
        kind: "refused",
        reason: "SANDBOX_PROVIDER=local-docker does not run in production.",
      };
    }
    if (config.app.composition === "cloud") {
      return {
        kind: "refused",
        reason: "SANDBOX_PROVIDER=local-docker does not run in Ratel Cloud.",
      };
    }
    return { kind: "local-docker" };
  }
  return boatApiKey ? { kind: "boat" } : { kind: "none" };
}

/**
 * The label value of the VMs of this deployment: `SANDBOX_DEPLOYMENT_ID`, else the first 16 hex
 * characters of the SHA-256 of the public URL, else of the base URL. It does not change while the
 * URL stays the same.
 */
export function sandboxDeploymentId(config: SandboxConfig): string {
  if (config.sandboxes.deploymentId) return config.sandboxes.deploymentId;
  const origin = config.app.publicUrl ?? config.app.baseUrl;
  return createHash("sha256").update(origin).digest("hex").slice(0, 16);
}
