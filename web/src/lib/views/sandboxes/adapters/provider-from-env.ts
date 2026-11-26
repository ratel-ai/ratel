import { createHash } from "node:crypto";
import { type Config, getConfig } from "@/config";
import type { SandboxProvider } from "../ports/sandbox-provider";
import { createBoatProvider } from "./boat-provider";

type SandboxConfig = Pick<Config, "sandboxes" | "app">;

const providers = new Map<string, SandboxProvider>();

/** Whether the provider is set up in the configuration. It makes no call. */
export function sandboxProviderConfigured(config: SandboxConfig = getConfig()): boolean {
  return Boolean(config.sandboxes.boatApiKey);
}

/** The provider, or null when it is not set up. It makes no call. */
export function sandboxProvider(config: SandboxConfig = getConfig()): SandboxProvider | null {
  const { boatApiKey: apiKey, boatApiUrl: baseUrl, boatVmType: vmType } = config.sandboxes;
  if (!apiKey) return null;
  const deploymentId = sandboxDeploymentId(config);
  const key = JSON.stringify([apiKey, baseUrl, vmType, deploymentId]);
  const known = providers.get(key);
  if (known) return known;
  const provider = createBoatProvider({ apiKey, baseUrl, vmType, deploymentId });
  providers.set(key, provider);
  return provider;
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
