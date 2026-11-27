import type { ModalClient } from "modal";
import { type Config, getConfig } from "@/config";
import type { SandboxProvider } from "../ports/sandbox-provider";
import { createModalProvider } from "./modal-provider";

type SandboxConfig = Pick<Config, "sandboxes">;

const providers = new Map<string, SandboxProvider>();

/** Whether the provider is set up in the configuration. It makes no call. */
export function sandboxProviderConfigured(config: SandboxConfig = getConfig()): boolean {
  const { modalTokenId, modalTokenSecret } = config.sandboxes;
  return Boolean(modalTokenId && modalTokenSecret);
}

/** The provider, or null when it is not set up. The SDK loads on the first call to the provider. */
export function sandboxProvider(config: SandboxConfig = getConfig()): SandboxProvider | null {
  const {
    modalTokenId: tokenId,
    modalTokenSecret: tokenSecret,
    region,
    modalApp,
  } = config.sandboxes;
  if (!tokenId || !tokenSecret) return null;
  const key = JSON.stringify([tokenId, tokenSecret, region, modalApp]);
  const known = providers.get(key);
  if (known) return known;
  let client: Promise<ModalClient> | undefined;
  const provider = createModalProvider({
    client: () => {
      client ??= import("modal").then(
        ({ ModalClient }) => new ModalClient({ tokenId, tokenSecret, logLevel: "error" }),
      );
      return client;
    },
    appName: modalApp,
    region,
  });
  providers.set(key, provider);
  return provider;
}
