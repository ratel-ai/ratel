/**
 * The product's name and the API address snippets point at. The defaults are local development
 * on the open-source edition; `.env` overrides them. `APP_NAME` is how the Cloud edition names
 * itself, and is deliberately undocumented.
 *
 * Copied modules read these at load, on the server and in the browser, so the root layout writes
 * the server's values into the page (`appConfigScript`) before any bundle runs. An operator can
 * then set them on a running image, with no rebuild.
 */

export interface AppConfig {
  name: string;
  baseUrl: string;
}

const DEFAULT_NAME = "Ratel";
const DEFAULT_BASE_URL = "http://localhost:3000/api/v1";

export function resolveAppConfig(env: Record<string, string | undefined>): AppConfig {
  return {
    name: env.APP_NAME?.trim() || DEFAULT_NAME,
    baseUrl: (env.BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
  };
}

declare global {
  interface Window {
    __RATEL_APP_CONFIG__?: AppConfig;
  }
}

const config: AppConfig =
  (typeof window === "undefined" ? undefined : window.__RATEL_APP_CONFIG__) ??
  resolveAppConfig(process.env);

export const APP_NAME = config.name;
export const BASE_URL = config.baseUrl;

/** The inline script that hands the server's values to the browser. `<` is escaped: no breakout. */
export function appConfigScript(value: AppConfig = config): string {
  return `window.__RATEL_APP_CONFIG__=${JSON.stringify(value).replace(/</g, "\\u003c")}`;
}
