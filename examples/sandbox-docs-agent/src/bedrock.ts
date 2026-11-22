import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { BEDROCK_PREFIX, docsModelId } from "./agent.js";

// The example's own entry points (chat, seed) pass the model as an ID string,
// and the AI SDK sends an ID string through AI Gateway. When DOCS_AGENT_MODEL
// is an `amazon-bedrock/<id>` value, this makes the AI SDK send ID strings to
// Bedrock instead, with the AWS credential chain (AWS_PROFILE, SSO, static
// keys). A sandbox run does not need it: the sandbox's resolver handles Bedrock.

/** Routes `amazon-bedrock/<id>` model strings to Bedrock. Returns false when the model is not on Bedrock. */
export function routeModelIdsToBedrock(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!docsModelId(env).startsWith(BEDROCK_PREFIX)) return false;
  const bedrock = createAmazonBedrock({
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
    credentialProvider: fromNodeProviderChain(),
  });
  (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER = {
    languageModel: (id: string) =>
      bedrock(id.slice(id.startsWith(BEDROCK_PREFIX) ? BEDROCK_PREFIX.length : 0)),
  };
  return true;
}
