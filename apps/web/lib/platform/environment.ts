/**
 * The one public runtime value the open-source edition ships to the browser: the deployment
 * environment label. Upstream also carried analytics and identity-provider keys; those belong
 * to the private edition's own injection, so `window.__ENV__` here can never leak a key.
 */
export interface PublicEnv {
  environment: string;
}

type PublicEnvSource = Readonly<Record<string, string | undefined>>;

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

/** Whether APP_ENV names a laptop or test environment (unset reads as "development"). */
export function isLocalEnvironment(env: PublicEnvSource): boolean {
  return LOCAL_ENVIRONMENTS.has((env.APP_ENV || "development").toLowerCase());
}

export function resolvePublicEnv(env: PublicEnvSource): PublicEnv {
  return { environment: env.APP_ENV || "development" };
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
  return resolvePublicEnv(process.env);
}

export function serializePublicEnv(env: PublicEnv): string {
  return JSON.stringify(env).replace(/</g, "\\u003c");
}

/**
 * The deployment environment reported to observability. Reads APP_ENV, deliberately not
 * NODE_ENV: NODE_ENV is "production" for any `next build`, including the image run on a laptop,
 * so it cannot tell a real deployment from a local one. Defaults to "development".
 */
export function deploymentEnvironment(): string {
  return getPublicEnv().environment;
}
