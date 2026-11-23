/**
 * The one public runtime value the open-source edition ships to the browser: the deployment
 * environment label. Upstream also carried analytics and identity-provider keys; those belong
 * to the private edition's own injection, so `window.__ENV__` here can never leak a key.
 */
import { type Config, getConfig } from "@/config";

export interface PublicEnv {
  environment: string;
}

declare global {
  interface Window {
    __ENV__?: PublicEnv;
  }
}

/**
 * Environments where a laptop-only affordance may run. An allowlist, so an unrecognized or
 * renamed environment fails closed rather than silently loosening a guard on a deployment.
 */
const LOCAL_ENVIRONMENTS: ReadonlySet<string> = new Set(["development", "local", "test"]);

/** Whether `app.environment` (APP_ENV) names a laptop or test environment (unset reads as "development"). */
export function isLocalEnvironment(environment: string = getConfig().app.environment): boolean {
  return LOCAL_ENVIRONMENTS.has(environment.toLowerCase());
}

export function resolvePublicEnv(config: Pick<Config, "app"> = getConfig()): PublicEnv {
  return { environment: config.app.environment };
}

let warnedMissingBrowserEnv = false;

export function getPublicEnv(): PublicEnv {
  if (typeof window !== "undefined") {
    if (window.__ENV__) return window.__ENV__;
    if (!warnedMissingBrowserEnv) {
      warnedMissingBrowserEnv = true;
      console.warn(
        "window.__ENV__ is missing; the inline env script may have been stripped by CSP, an extension, or a RootLayout change.",
      );
    }
  }
  return resolvePublicEnv();
}

export function serializePublicEnv(env: PublicEnv): string {
  return JSON.stringify(env).replace(/</g, "\\u003c");
}

/**
 * The deployment environment reported to observability. Reads `app.environment` (APP_ENV), deliberately not
 * NODE_ENV: NODE_ENV is "production" for any `next build`, including the image run on a laptop,
 * so it cannot tell a real deployment from a local one. Defaults to "development".
 */
export function deploymentEnvironment(): string {
  return getPublicEnv().environment;
}
