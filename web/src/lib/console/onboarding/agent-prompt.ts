import {
  buildQuickstart,
  QUICKSTART_CAPTURE_ENV,
  QUICKSTART_CAPTURE_MODE,
  QUICKSTART_KEY_ENV,
} from "@/lib/console/onboarding/quickstart";

/**
 * The prompt the onboarding hands to the customer's coding agent ("Copy this prompt for your
 * agent"): everything it needs to wire Ratel into the app, and to prove it worked, in one paste.
 *
 * Pure, like the snippets it reuses, so what we tell someone's agent is reviewable and tested
 * (agent-prompt.test.ts). It never carries the key: the agent reads `RATEL_API_KEY` from the
 * environment and the person sets it, so the secret stays out of the agent's transcript. (A
 * single-use claim code the agent redeems on its own is the follow-up, RTL-373.)
 */

/** Where an agent reads how to integrate Ratel; it links the SDKs' own llms.txt. */
export const RATEL_LLMS_TXT_URL = "https://github.com/ratel-ai/ratel/blob/main/llms.txt";

export interface AgentPromptTarget {
  /** The project's display name, as the person typed it. */
  projectName: string;
  /** Project slug, the OTel `service.name` its traces group under. */
  serviceName: string;
  /** Absolute OTLP traces URL for this deployment. */
  endpoint: string;
  /** The project's Traces page in the console, where the first trace shows up. */
  tracesUrl: string;
  /** Whether the person asked for content capture on the page. */
  captureContent?: boolean;
}

/** Quote a value the person or the deployment chose, so it cannot break out of its sentence. */
function quoted(value: string): string {
  return JSON.stringify(value);
}

/** The packages each path installs; `@opentelemetry/sdk-node` only when we start the provider. */
const PROCESSOR_PACKAGES =
  "@ratel-ai/cloud-sdk @opentelemetry/api @opentelemetry/sdk-trace-base " +
  "@opentelemetry/exporter-trace-otlp-proto";
const NODE_SDK_PACKAGES = `${PROCESSOR_PACKAGES} @opentelemetry/sdk-node`;

function captureStep(captureContent: boolean): string {
  return captureContent
    ? `5. Content capture is on. Set ${QUICKSTART_CAPTURE_ENV}=${QUICKSTART_CAPTURE_MODE} where the app runs. That variable only reaches OpenTelemetry's GenAI instrumentations: when the framework decides capture itself, switch it on there too (Eve: its tracePolicy; Vercel AI SDK: recordInputs and recordOutputs in experimental_telemetry).`
    : "5. Content capture is off. Do not switch on message content capture: Ratel reads runtime metadata only (what the agent searched for, which tools it was shown and ran).";
}

/**
 * The prompt, as Markdown an agent reads top to bottom. Prose runs one line per item, unwrapped:
 * the agent does not care, and the page's preview soft-wraps it to its own width.
 */
export function buildAgentPrompt(target: AgentPromptTarget): string {
  const { projectName, serviceName, endpoint, tracesUrl, captureContent = false } = target;
  const processor = `new RatelSpanProcessor({ endpoint: ${quoted(endpoint)} })`;
  const nodeSdk = buildQuickstart("typescript", { endpoint, serviceName, captureContent }).code;

  return [
    `Connect this app's AI agent to Ratel, so its traces reach the Ratel project ${quoted(projectName)}.`,
    "",
    "## What you need",
    "",
    `- Traces endpoint (OTLP over HTTP): ${endpoint}`,
    `- API key: the ${QUICKSTART_KEY_ENV} environment variable. I set it myself. Never ask me to paste the key into this chat, never hard-code it, never commit it. If the app has no ${QUICKSTART_KEY_ENV} entry yet, add an empty \`${QUICKSTART_KEY_ENV}=\` line to the env file it already loads (such as .env.local), make sure that file is git-ignored, and tell me to fill it in.`,
    `- service.name: ${quoted(serviceName)}. Ratel groups the traces under this name.`,
    '- Package: @ratel-ai/cloud-sdk. Its RatelSpanProcessor (from "@ratel-ai/cloud-sdk/otel") forwards the OpenTelemetry GenAI spans (gen_ai.*, ratel.*) to Ratel and leaves any exporter the app already runs alone.',
    `- Docs for agents: ${RATEL_LLMS_TXT_URL}. Read it when something below does not fit this codebase.`,
    "",
    "## Steps",
    "",
    "1. Find where the agent calls its model, and whether the app already starts an OpenTelemetry provider: Next.js with @vercel/otel (registerOTel in instrumentation.ts), Eve (agent/instrumentation/), Mastra (its telemetry or observability config), or a NodeSDK or tracer provider of its own.",
    "2. If a provider already exists, add Ratel to it as one more span processor. Do not start a second provider with NodeSDK: two providers compete and spans go missing.",
    `   Install: npm install ${PROCESSOR_PACKAGES} (with the project's package manager).`,
    `   - Next.js with @vercel/otel: registerOTel({ serviceName: ${quoted(serviceName)}, spanProcessors: ["auto", ${processor}] }). Keep "auto" so the exporters already configured stay on.`,
    "   - Eve: create agent/instrumentation/ratel.ts:",
    "     ```ts",
    '     import { RatelSpanProcessor } from "@ratel-ai/cloud-sdk/otel";',
    '     import { otelIntegration } from "eve/instrumentation/otel";',
    "",
    "     export default otelIntegration({",
    `       spanProcessors: [${processor}],`,
    "     });",
    "     ```",
    `   - Mastra, or any other provider: add ${processor} to the span processors it is built with.`,
    "3. If nothing starts a provider, start one with NodeSDK as early as the process starts, before the agent's code loads.",
    `   Install: npm install ${NODE_SDK_PACKAGES}`,
    "   ```ts",
    ...nodeSdk.split("\n").map((line) => (line === "" ? "" : `   ${line}`)),
    "   ```",
    "4. Make sure the model calls emit GenAI spans. Some libraries only trace when asked: with the Vercel AI SDK, pass experimental_telemetry: { isEnabled: true } to each generateText or streamText call.",
    captureStep(captureContent),
    "6. Verify the first trace:",
    `   - Run the agent once with a real request, with ${QUICKSTART_KEY_ENV} set.`,
    `   - The trace shows up at ${tracesUrl} within a minute or so. If the Ratel MCP server is connected, get_traces_ingest_diagnostics says what the endpoint has received.`,
    "   - Nothing arrives? Check the key and the endpoint on their own (401 means the key is missing or wrong):",
    `     curl -sS -o /dev/null -w "%{http_code}\\n" -X POST ${endpoint} -H "Authorization: Bearer $${QUICKSTART_KEY_ENV}" -H "Content-Type: application/json" -d '{"resourceSpans":[]}'`,
    "7. Tell me which files you changed, which path you took (the existing provider or NodeSDK), and whether the first trace arrived.",
  ].join("\n");
}
