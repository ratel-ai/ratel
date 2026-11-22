import {
  CURRENT_PRICES,
  type ModelPrice,
  type PriceBook,
  type PriceOverrides,
  priceFor,
  resolvePrice,
} from "@/lib/ingest/pricing";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import {
  deleteModelPrice,
  type ModelPriceInput,
  type ModelPricingDb,
  type SeenModel,
  saveModelPrice,
} from "./store";

/**
 * Settings > General > Model pricing (RC-482): the models the project's calls
 * used, the price each pays, and a project's own prices. Only an admin of the
 * project's organization changes a price. Each change re-prices the model's
 * stored calls.
 */

/** Where a model's price comes from: the project, the built-in list, or nowhere. */
export type PriceSource = "custom" | "built-in" | "unpriced";

export interface ModelPricingRow {
  model: string;
  calls: number;
  unpricedCalls: number;
  source: PriceSource;
  /** The rates the model's calls pay now. Null when unpriced. */
  price: ModelPriceInput | null;
  /** The built-in rates, to show next to a custom price. */
  builtIn: ModelPriceInput | null;
  /** The model id the custom price is saved under (a dated id pays its model's price). */
  customModel: string | null;
  /** The prompt size over which the built-in price bills higher rates. */
  longContextOver: number | null;
}

export type ParsedModelPrice =
  | { ok: true; model: string; price: ModelPriceInput }
  | { ok: false; field: PriceField; error: string };

export type PriceField = "model" | "input" | "output" | "cachedInput" | "cacheWrite";

export type ModelPricingResult =
  | { ok: true; model: string }
  | { ok: false; error: string; field?: PriceField };

export interface ModelPricingDeps {
  db?: Pick<ModelPricingDb, "insert" | "delete">;
  /** The signed-in person, or null. */
  getActor: () => Promise<{ userId: string; externalId: string } | null>;
  /** The person's role in the project's organization, or null when they are not a member. */
  findRole: (projectId: string, userId: string) => Promise<string | null>;
  /** An admin support session may look but not change settings. */
  isRestricted?: () => Promise<boolean>;
  /**
   * Re-price the model's stored calls; runs after the response. `version` is
   * the saved price's `updated_at` (null after a reset), so a slower re-price
   * of an older save never overwrites a newer one.
   */
  reprice: (projectId: string, model: string, version: Date | null) => void;
  track?: (event: {
    externalId: string;
    projectId: string;
    model: string;
    action: "saved" | "reset";
  }) => Promise<void>;
}

export const MODEL_PRICING_ERRORS = {
  signed_out: "Sign in to change model prices.",
  not_found: "No project you belong to has that ID.",
  not_admin: "Only organization admins can change model prices.",
  restricted: "A support session cannot change settings.",
} as const;

const MAX_MODEL_LENGTH = 200;
const MAX_PRICE = 1_000_000;
const logger = getLogger("model-pricing/settings");

/**
 * The table: every model the project's calls used, then any model priced by
 * hand that no call used yet. Unpriced models come first (they need a price),
 * then the busiest.
 */
export function modelPricingRows(
  seen: readonly SeenModel[],
  overrides: PriceOverrides,
): ModelPricingRow[] {
  // The current prices and the project's own.
  const book: PriceBook = { overrides };
  const rows = seen.map((entry) => row(entry, book));
  const listed = new Set(rows.map((entry) => entry.customModel ?? entry.model));
  for (const model of Object.keys(overrides).sort()) {
    if (!listed.has(model) && !rows.some((entry) => entry.model === model)) {
      rows.push(row({ model, calls: 0, unpricedCalls: 0 }, book));
    }
  }
  const rank = (entry: ModelPricingRow) => (entry.source === "unpriced" ? 0 : 1);
  return rows.sort(
    (a, b) => rank(a) - rank(b) || b.calls - a.calls || a.model.localeCompare(b.model),
  );
}

/** Check what a person typed: a model id and rates in USD per 1M tokens. Empty cache rates mean "same as input". */
export function parseModelPrice(input: unknown): ParsedModelPrice {
  const raw = (input ?? {}) as Record<string, unknown>;
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!model || model.length > MAX_MODEL_LENGTH) {
    return { ok: false, field: "model", error: "Enter the model id your calls report." };
  }
  const price: ModelPriceInput = { input: 0, output: 0 };
  for (const field of ["input", "output", "cachedInput", "cacheWrite"] as const) {
    const value = raw[field];
    const optional = field === "cachedInput" || field === "cacheWrite";
    if (optional && (value === undefined || value === null || value === "")) continue;
    const parsed = rate(value);
    if (parsed === null) return { ok: false, field, error: "Enter a price of 0 or more." };
    if (parsed >= MAX_PRICE)
      return { ok: false, field, error: "Enter a price under $1,000,000 per 1M tokens." };
    price[field] = parsed;
  }
  return { ok: true, model, price };
}

/** Save a project's price of one model, then re-price its stored calls. Admin-only. */
export async function saveProjectModelPrice(
  projectId: string,
  input: unknown,
  deps: ModelPricingDeps,
): Promise<ModelPricingResult> {
  const parsed = parseModelPrice(input);
  const actor = await authorize(projectId, deps);
  if ("error" in actor) return actor;
  if (!parsed.ok) return parsed;
  const version = await saveModelPrice(
    projectId,
    parsed.model,
    parsed.price,
    actor.externalId,
    deps.db ?? getDb(),
  );
  logger.info({ project_id: projectId, model: parsed.model, outcome: "saved" }, "model price set");
  deps.reprice(projectId, parsed.model, version);
  await deps.track?.({
    externalId: actor.externalId,
    projectId,
    model: parsed.model,
    action: "saved",
  });
  return { ok: true, model: parsed.model };
}

/** Drop a project's price of one model, so the built-in price (or none) applies again. Admin-only. */
export async function resetProjectModelPrice(
  projectId: string,
  model: string,
  deps: ModelPricingDeps,
): Promise<ModelPricingResult> {
  const actor = await authorize(projectId, deps);
  if ("error" in actor) return actor;
  await deleteModelPrice(projectId, model, deps.db ?? getDb());
  logger.info({ project_id: projectId, model, outcome: "reset" }, "model price set");
  deps.reprice(projectId, model, null);
  await deps.track?.({ externalId: actor.externalId, projectId, model, action: "reset" });
  return { ok: true, model };
}

function row(entry: SeenModel, book: PriceBook): ModelPricingRow {
  const resolved = resolvePrice(entry.model, book);
  const builtIn = priceFor(entry.model, CURRENT_PRICES);
  const isCustom = resolved?.source === "custom";
  return {
    model: entry.model,
    calls: entry.calls,
    unpricedCalls: entry.unpricedCalls,
    source: resolved === null ? "unpriced" : resolved.source,
    price: resolved && rates(resolved.price),
    builtIn: builtIn && rates(builtIn),
    customModel: isCustom ? resolved.key : null,
    longContextOver: !isCustom && builtIn?.longContext ? builtIn.longContext.threshold : null,
  };
}

function rates(price: ModelPrice): ModelPriceInput {
  return {
    input: price.input,
    output: price.output,
    ...(price.cachedInput !== undefined ? { cachedInput: price.cachedInput } : {}),
    ...(price.cacheWrite !== undefined ? { cacheWrite: price.cacheWrite } : {}),
  };
}

function rate(value: unknown): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function authorize(
  projectId: string,
  deps: ModelPricingDeps,
): Promise<{ userId: string; externalId: string } | { ok: false; error: string }> {
  const actor = await deps.getActor();
  if (!actor) return refuse("signed_out", projectId);
  const role = await deps.findRole(projectId, actor.userId);
  if (role === null) return refuse("not_found", projectId);
  if (role !== "admin") return refuse("not_admin", projectId);
  if (await deps.isRestricted?.()) return refuse("restricted", projectId);
  return actor;
}

function refuse(
  code: keyof typeof MODEL_PRICING_ERRORS,
  projectId: string,
): { ok: false; error: string } {
  logger.info({ project_id: projectId, outcome: code }, "model price set");
  return { ok: false, error: MODEL_PRICING_ERRORS[code] };
}
