import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { gateway } from "ai";

// The agent hands the AI SDK its model as an ID string (from the Ratel catalog).
// The AI SDK sends ID strings through AI Gateway. This makes it send
// `amazon-bedrock/<id>` strings to Bedrock instead, with the AWS credential chain
// (AWS_PROFILE, SSO, static keys), and every other ID to the gateway as before.

export const BEDROCK_PREFIX = "amazon-bedrock/";

/** Installs the AI SDK default provider that routes `amazon-bedrock/` IDs to Bedrock. */
export function routeModelIds(env: NodeJS.ProcessEnv = process.env): void {
  let bedrock: ReturnType<typeof createAmazonBedrock> | undefined;
  (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER = {
    languageModel: (id: string) => {
      if (!id.startsWith(BEDROCK_PREFIX)) return gateway.languageModel(id);
      bedrock ??= createAmazonBedrock({
        region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
        credentialProvider: fromNodeProviderChain(),
      });
      return bedrock(id.slice(BEDROCK_PREFIX.length));
    },
  };
}
