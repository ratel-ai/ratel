import { getAuthHeaders } from "@anthropic-ai/bedrock-sdk/core/auth";
import { type AuthClient, GoogleAuth } from "google-auth-library";
import type { Authorize } from "./http";

/** How a request to a cloud is signed with the login the deployment already has. */

let google: GoogleAuth | null = null;

/**
 * The deployment's Google login (Application Default Credentials): a service account on Google
 * Cloud, `GOOGLE_APPLICATION_CREDENTIALS`, or `gcloud auth application-default login`. The
 * library keeps the token and renews it before its hour is up.
 */
export async function googleClient(): Promise<AuthClient> {
  google ??= new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  try {
    return await google.getClient();
  } catch (error) {
    // A login that failed is not kept, so one that appears later works without a restart.
    google = null;
    throw error;
  }
}

export function googleToken(login: () => Promise<AuthClient> = googleClient): Authorize {
  return async () => {
    const { token } = await (await login()).getAccessToken();
    if (!token) throw new Error("the Google login gave no access token");
    return { authorization: `Bearer ${token}` };
  };
}

export interface AwsSigning {
  region: string;
  /** A Bedrock API key, in place of a signature. */
  apiKey?: string;
  /** AWS keys in place of the credential chain (tests). */
  keys?: { accessKey: string; secretKey: string };
}

/** Signs for Bedrock with a Bedrock API key, else with the AWS credential chain (SigV4). */
export function awsSigned({ region, apiKey, keys }: AwsSigning): Authorize {
  if (apiKey) return () => ({ authorization: `Bearer ${apiKey}` });
  return ({ url, headers, body }) =>
    getAuthHeaders(
      { method: "POST", headers, body },
      {
        url,
        regionName: region,
        awsAccessKey: keys?.accessKey,
        awsSecretKey: keys?.secretKey,
        awsSessionToken: undefined,
      },
    );
}
