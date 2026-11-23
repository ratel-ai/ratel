import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { AuthClient } from "google-auth-library";
import type { AnthropicClient, AnthropicClientOptions } from "@/lib/readings/anthropic/client";
import { wellFormedJson } from "@/lib/readings/text/well-formed";
import type { ResolvedVendor } from "../config";
import { googleClient } from "./cloud-auth";

/**
 * Claude on the clouds a deployment names as its vendor (`gcp`, `bedrock`), as the client the
 * Claude code already takes. Ratel's own Bedrock deployment does not come here: it sets
 * `ANTHROPIC_BACKEND=bedrock` and keeps `lib/readings/anthropic/client.ts`.
 *
 * Every address is written out, so no SDK variable (`ANTHROPIC_VERTEX_BASE_URL`,
 * `ANTHROPIC_BEDROCK_BASE_URL`) can move customer data, and no Anthropic key is read.
 */

export interface ClaudeHostOptions {
  fetch?: typeof fetch;
  /** The Google login (tests). */
  googleAuth?: () => Promise<AuthClient>;
  /** AWS keys in place of the credential chain (tests). */
  awsKeys?: { accessKey: string; secretKey: string };
}

/** Vertex AI's host for a location: worldwide, one of its multi-regions, or a region. */
export function vertexHost(location: string): string {
  if (location === "global") return "aiplatform.googleapis.com";
  return location === "us" || location === "eu"
    ? `aiplatform.${location}.rep.googleapis.com`
    : `${location}-aiplatform.googleapis.com`;
}

/**
 * Claude on Vertex AI. The login is asked for on the first call, not when the client is built:
 * one that fails must fail that call, and the next call must be able to try again.
 */
function vertexClient(
  vendor: ResolvedVendor,
  options: AnthropicClientOptions,
  host: ClaudeHostOptions,
): AnthropicClient {
  const login = host.googleAuth ?? googleClient;
  const connect = async () =>
    new AnthropicVertex({
      ...options,
      ...(host.fetch ? { fetch: host.fetch } : {}),
      projectId: vendor.project ?? null,
      region: vendor.location ?? null,
      baseURL: `https://${vertexHost(vendor.location ?? "")}/v1`,
      authClient: await login(),
      openTelemetry: false,
    });
  return {
    messages: {
      create: async (params: Anthropic.MessageCreateParams, request?: Anthropic.RequestOptions) =>
        (await connect()).messages.create(wellFormedJson(params), request),
      // The callers of a stream ask for its final message and nothing else.
      stream: (params: Anthropic.MessageStreamParams, request?: Anthropic.RequestOptions) => ({
        finalMessage: async () =>
          (await connect()).messages.stream(wellFormedJson(params), request).finalMessage(),
      }),
    },
  } as unknown as AnthropicClient;
}

/** A Claude model as Bedrock names it in this geography; a full Bedrock id is used as given. */
export function bedrockModelId(model: string, profile: string): string {
  return model.includes("anthropic.") ? model : `${profile}.anthropic.${model}`;
}

function bedrockClient(
  vendor: ResolvedVendor,
  options: AnthropicClientOptions,
  host: ClaudeHostOptions,
): AnthropicClient {
  const common = {
    ...options,
    ...(host.fetch ? { fetch: host.fetch } : {}),
    // Said either way: left out, the SDK would read the variable itself.
    apiKey: vendor.apiKey,
    awsRegion: vendor.region ?? "",
    baseURL: `https://bedrock-runtime.${vendor.region}.amazonaws.com`,
    openTelemetry: false as const,
  };
  const client = host.awsKeys
    ? new AnthropicBedrock({
        ...common,
        awsAccessKey: host.awsKeys.accessKey,
        awsSecretKey: host.awsKeys.secretKey,
      })
    : new AnthropicBedrock(common);
  const named = <T extends { model: string }>(params: T): T => ({
    ...params,
    model: bedrockModelId(params.model, vendor.profile ?? ""),
  });
  return {
    messages: {
      create: (params: Anthropic.MessageCreateParams, request?: Anthropic.RequestOptions) =>
        client.messages.create(wellFormedJson(named(params)), request),
      stream: (params: Anthropic.MessageStreamParams, request?: Anthropic.RequestOptions) =>
        client.messages.stream(wellFormedJson(named(params)), request),
    },
  } as unknown as AnthropicClient;
}

/** The Claude client of a vendor that hosts Claude itself; null for any other vendor. */
export function claudeHostClient(
  vendor: ResolvedVendor,
  options: AnthropicClientOptions = {},
  host: ClaudeHostOptions = {},
): AnthropicClient | null {
  if (vendor.name === "gcp") return vertexClient(vendor, options, host);
  if (vendor.name === "bedrock") return bedrockClient(vendor, options, host);
  return null;
}

/** The host on a spend line's `backend`. */
export function claudeHostName(vendor: ResolvedVendor): string | undefined {
  if (vendor.name === "gcp") return "vertex";
  return vendor.name === "bedrock" ? "bedrock" : undefined;
}
