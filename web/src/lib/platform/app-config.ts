/**
 * The product's name and the deployment origin snippets start from: `app.name` (APP_NAME) and
 * `app.baseUrl` (BASE_URL) in `web/src/config.ts`. The defaults are local development on the
 * open-source edition. `APP_NAME` is how the Cloud edition names itself, and is deliberately
 * undocumented.
 *
 * Copied modules read these at load, on the server and in the browser, so the root layout writes
 * the server's values into the page (`appConfigScript`) before any bundle runs. An operator can
 * then set them on a running image, with no rebuild. A browser bundle resolves `@/config` to the
 * defaults (`config-defaults.ts`): an MCP Apps view, which has no page script, names the app's
 * default.
 */
import { type Config, getConfig } from "@/config";

export interface AppConfig {
  name: string;
  baseUrl: string;
  /**
   * The edition's short name for the service doing the work ("Cloud"), from its `productName`;
   * absent in the open-source edition. Set at startup, not from the environment.
   */
  serviceName?: string;
}

/** Path prefix for the Bearer-authed API surface under the deployment origin. */
export const API_V1_PREFIX = "/api/v1";

/** Strip trailing slashes, then a legacy `/api/v1` that older `.env` files still carried. */
function normalizeBaseUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.endsWith(API_V1_PREFIX) ? trimmed.slice(0, -API_V1_PREFIX.length) : trimmed;
}

export function resolveAppConfig(config: Pick<Config, "app"> = getConfig()): AppConfig {
  return { name: config.app.name, baseUrl: normalizeBaseUrl(config.app.baseUrl) };
}

declare global {
  interface Window {
    __RATEL_APP_CONFIG__?: AppConfig;
  }
}

const config: AppConfig =
  (typeof window === "undefined" ? undefined : window.__RATEL_APP_CONFIG__) ?? resolveAppConfig();

export const APP_NAME = config.name;

/** What the browser is handed: the server's values and the edition's short name, if any. */
function browserConfig(): AppConfig {
  const name = editionServiceName();
  return name ? { ...config, serviceName: name } : config;
}
/** This deployment's origin. Use {@link apiUrl} for API and ingest URLs under `/api/v1`. */
export const BASE_URL = config.baseUrl;

/**
 * Absolute URL under the Bearer-authed API. `apiUrl()` is the API root;
 * `apiUrl("/traces")` is `http://localhost:3000/api/v1/traces`.
 */
export function apiUrl(path = ""): string {
  const suffix = path === "" ? "" : path.startsWith("/") ? path : `/${path}`;
  return `${BASE_URL}${API_V1_PREFIX}${suffix}`;
}

// On globalThis: Next loads instrumentation and the routes as separate module instances.
const EDITION_SERVICE_NAME = Symbol.for("ratel.editionServiceName");
const slot = globalThis as { [EDITION_SERVICE_NAME]?: string };

/** Server, at startup: the composed edition's short name (`productName.short`), if it has one. */
export function setEditionServiceName(name: string | undefined): void {
  slot[EDITION_SERVICE_NAME] = name;
}

/** The edition's short name ("Cloud"), on the server or in the browser; null without one. */
export function editionServiceName(): string | null {
  const name =
    typeof window === "undefined"
      ? slot[EDITION_SERVICE_NAME]
      : window.__RATEL_APP_CONFIG__?.serviceName;
  return name ?? null;
}

/**
 * The service doing the work, as a sentence names it ("Cloud builds one once searches arrive"):
 * the edition's short name, else `APP_NAME`.
 */
export function serviceName(): string {
  return editionServiceName() ?? APP_NAME;
}

/** The inline script that hands the server's values to the browser. `<` is escaped: no breakout. */
export function appConfigScript(value: AppConfig = browserConfig()): string {
  return `window.__RATEL_APP_CONFIG__=${JSON.stringify(value).replace(/</g, "\\u003c")}`;
}
