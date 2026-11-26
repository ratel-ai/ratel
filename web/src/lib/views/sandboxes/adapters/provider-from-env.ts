import { type Config, getConfig } from "@/config";
import type { SandboxProvider } from "../ports/sandbox-provider";
import { createBoatProvider } from "./boat-provider";

type SandboxConfig = Pick<Config, "sandboxes">;

const providers = new Map<string, SandboxProvider>();

/** Whether the provider is set up in the configuration. It makes no call. */
export function sandboxProviderConfigured(config: SandboxConfig = getConfig()): boolean {
  return Boolean(config.sandboxes.boatApiKey);
}

/** The provider, or null when it is not set up. It makes no call. */
export function sandboxProvider(config: SandboxConfig = getConfig()): SandboxProvider | null {
  const { boatApiKey: apiKey, boatApiUrl: baseUrl, boatVmType: vmType } = config.sandboxes;
  if (!apiKey) return null;
  const key = JSON.stringify([apiKey, baseUrl, vmType]);
  const known = providers.get(key);
  if (known) return known;
  const provider = createBoatProvider({ apiKey, baseUrl, vmType });
  providers.set(key, provider);
  return provider;
}
