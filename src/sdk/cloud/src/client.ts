import type { SkillCatalog, TraceSession } from "@ratel-ai/sdk";
import {
  type FetchCatalogResult,
  fetchCatalog,
  SkillSync,
  type SkillSyncOptions,
} from "./catalog-sync.js";
import { CloudConfigError } from "./errors.js";
import { CloudExporter, type CloudExporterOptions } from "./exporter.js";
import { CloudHttp } from "./http.js";
import { reportRunMetrics } from "./run-metrics.js";
import { SuggestionsClient } from "./suggestions.js";
import type { RunMetrics } from "./types.js";

export interface CloudClientOptions {
  /** Cloud origin, e.g. `https://cloud.ratel.sh`. Defaults to `RATEL_CLOUD_URL`. */
  baseUrl?: string;
  /** Project API key (`rtl_...`). Defaults to `RATEL_CLOUD_API_KEY`. */
  apiKey?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

/**
 * Client for Ratel Cloud, authenticated with a per-project API key. One
 * client fronts every project-key surface: catalog pull/cache sync, the
 * trace-event exporter, suggestion review, and coarse run metrics.
 */
export class CloudClient {
  readonly http: CloudHttp;
  /** Suggestion review: list / get / approve / reject / generate. */
  readonly suggestions: SuggestionsClient;

  constructor(options: CloudClientOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env.RATEL_CLOUD_URL;
    const apiKey = options.apiKey ?? process.env.RATEL_CLOUD_API_KEY;
    if (!baseUrl) {
      throw new CloudConfigError(
        "Ratel Cloud base URL missing: pass baseUrl or set RATEL_CLOUD_URL",
      );
    }
    if (!apiKey) {
      throw new CloudConfigError(
        "Ratel Cloud API key missing: pass apiKey or set RATEL_CLOUD_API_KEY",
      );
    }
    this.http = new CloudHttp(baseUrl, apiKey, options.fetch);
    this.suggestions = new SuggestionsClient(this.http);
  }

  /** Conditional GET of the published catalog. Prefer {@link syncSkills}. */
  fetchCatalog(etag?: string): Promise<FetchCatalogResult> {
    return fetchCatalog(this.http, etag);
  }

  /**
   * Create a sync handle without touching the network — for hosts that want
   * to tolerate an offline start (`sync.start()` retries on the interval).
   */
  createSkillSync(catalog: SkillCatalog, opts: SkillSyncOptions = {}): SkillSync {
    return new SkillSync(this.http, catalog, opts);
  }

  /**
   * Pull the published catalog into `catalog` (throws on failure — there is
   * no disk cache in v1, so an offline start has no cloud skills) and return
   * the handle for `refresh()` / `start()` re-syncing.
   */
  async syncSkills(catalog: SkillCatalog, opts: SkillSyncOptions = {}): Promise<SkillSync> {
    const sync = this.createSkillSync(catalog, opts);
    await sync.refresh();
    return sync;
  }

  /**
   * Create the trace exporter for a shared `TraceSession` (ADR-0013). Call
   * `start()` on the result; the session should have no other drainer.
   */
  createExporter(session: TraceSession, opts: CloudExporterOptions = {}): CloudExporter {
    return new CloudExporter(session, this.http, opts);
  }

  /**
   * Manually report per-run token/cost metrics to the coarse
   * `POST /api/v1/events` stream. All-or-nothing (batch ≤ 500); throws on
   * failure so the host owns error handling.
   */
  reportRunMetrics(metrics: RunMetrics | RunMetrics[]): Promise<void> {
    return reportRunMetrics(this.http, metrics);
  }
}
