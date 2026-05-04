import { randomBytes } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { ClearScope, RatelOAuthStore } from "./store.js";

export interface RatelOAuthProviderOptions {
  store: RatelOAuthStore;
  /** Human-readable client name used during DCR. Default: `Ratel MCP gateway`. */
  clientName?: string;
  /** Pre-registered client_id to use when DCR isn't supported by the auth server. */
  staticClientId?: string;
  /** Pre-registered client_secret. Strongly discouraged; PKCE-public clients are preferred. */
  staticClientSecret?: string;
  /** Active redirect URI; matches the loopback callback server's URL when an interactive flow is in progress. */
  redirectUrl?: string | URL;
  /** Initial requested scope. The SDK applies SEP-835 selection on top of this. */
  scope?: string;
  /**
   * Called when the SDK asks the client to send the user agent to the authorization URL.
   * Interactive flows: open the user's browser. Non-interactive: log + record (the gateway
   * will surface `needsAuth` instead of blocking).
   */
  onRedirect?: (url: URL) => void | Promise<void>;
}

const DEFAULT_CLIENT_NAME = "Ratel MCP gateway";
const STATE_BYTES = 16;

export class RatelOAuthProvider implements OAuthClientProvider {
  private readonly store: RatelOAuthStore;
  private readonly _redirectUrl?: string | URL;
  private readonly opts: RatelOAuthProviderOptions;

  constructor(opts: RatelOAuthProviderOptions) {
    this.store = opts.store;
    this._redirectUrl = opts.redirectUrl;
    this.opts = opts;
  }

  get redirectUrl(): string | URL | undefined {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
      client_name: this.opts.clientName ?? DEFAULT_CLIENT_NAME,
      redirect_uris: this._redirectUrl ? [String(this._redirectUrl)] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.opts.staticClientSecret ? "client_secret_basic" : "none",
    };
    if (this.opts.scope) metadata.scope = this.opts.scope;
    return metadata;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.store.load()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.save({ tokens });
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = (await this.store.load()).client_information;
    if (stored) return stored;
    if (this.opts.staticClientId) {
      const info: OAuthClientInformationMixed = { client_id: this.opts.staticClientId };
      if (this.opts.staticClientSecret) {
        (info as { client_secret?: string }).client_secret = this.opts.staticClientSecret;
      }
      return info;
    }
    return undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.store.save({ client_information: info as OAuthClientInformationFull });
  }

  async state(): Promise<string> {
    const value = randomBytes(STATE_BYTES).toString("hex");
    await this.store.save({ state: value });
    return value;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.store.save({ code_verifier: verifier });
  }

  async codeVerifier(): Promise<string> {
    const v = (await this.store.load()).code_verifier;
    if (!v) throw new Error("no code verifier stored for this upstream");
    return v;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.opts.onRedirect?.(url);
  }

  async invalidateCredentials(scope: ClearScope): Promise<void> {
    await this.store.clear(scope);
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.store.save({ discovery_state: state });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.store.load()).discovery_state;
  }
}
