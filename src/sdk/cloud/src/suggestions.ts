import { CloudApiError } from "./errors.js";
import type { CloudHttp } from "./http.js";
import type { Suggestion, SuggestionStatus, SuggestionType } from "./types.js";

export interface ListSuggestionsOptions {
  status?: SuggestionStatus;
  type?: SuggestionType;
  /** 1–100, Cloud defaults to 50. */
  limit?: number;
}

export interface ListSuggestionsResult {
  count: number;
  suggestions: Suggestion[];
}

export interface GenerateSuggestionsResult {
  jobId: string;
  /** True when an in-flight generation run was reused instead of enqueued. */
  coalesced: boolean;
}

/**
 * Typed wrapper over the project-key suggestions REST (ADR-0014 companion
 * contract, mirroring Cloud's `SerializedSuggestion`). Approving does NOT
 * auto-refresh any catalog sync — call `SkillSync.refresh()` after an approve
 * to pull the resulting skill.
 */
export class SuggestionsClient {
  constructor(private readonly http: CloudHttp) {}

  async list(opts: ListSuggestionsOptions = {}): Promise<ListSuggestionsResult> {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.type) params.set("type", opts.type);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const query = params.size > 0 ? `?${params}` : "";
    const response = await this.http.request(`/api/v1/suggestions${query}`);
    return (await this.parse(response)) as ListSuggestionsResult;
  }

  async get(id: string): Promise<Suggestion> {
    const response = await this.http.request(`/api/v1/suggestions/${encodeURIComponent(id)}`);
    const payload = (await this.parse(response)) as { suggestion: Suggestion };
    return payload.suggestion;
  }

  async approve(id: string): Promise<Suggestion> {
    const response = await this.http.request(
      `/api/v1/suggestions/${encodeURIComponent(id)}/approve`,
      { method: "POST", body: "{}" },
    );
    const payload = (await this.parse(response)) as { suggestion: Suggestion };
    return payload.suggestion;
  }

  async reject(id: string, opts: { reason?: string } = {}): Promise<Suggestion> {
    const response = await this.http.request(
      `/api/v1/suggestions/${encodeURIComponent(id)}/reject`,
      { method: "POST", body: JSON.stringify(opts) },
    );
    const payload = (await this.parse(response)) as { suggestion: Suggestion };
    return payload.suggestion;
  }

  /** Enqueue a generation run; poll `list()` afterwards for new proposals. */
  async generate(): Promise<GenerateSuggestionsResult> {
    const response = await this.http.request("/api/v1/suggestions/generate", {
      method: "POST",
      body: "{}",
    });
    return (await this.parse(response)) as GenerateSuggestionsResult;
  }

  private async parse(response: Response): Promise<unknown> {
    const payload = (await response.json().catch(() => undefined)) as
      | { error?: string; reason?: string }
      | undefined;
    if (!response.ok) {
      throw new CloudApiError(
        `suggestions request failed (HTTP ${response.status}${payload?.reason ? `: ${payload.reason}` : ""})`,
        response.status,
        payload?.error,
      );
    }
    return payload;
  }
}
