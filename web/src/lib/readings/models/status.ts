import { desc, eq, sql } from "drizzle-orm";
import { type Config, getConfig } from "@/config";
import { getDb } from "@/lib/platform/db/client";
import { deploymentEnvironment } from "@/lib/platform/environment";
import { getLogger } from "@/lib/platform/logger";
import { onModelCall } from "@/lib/platform/model-call";
import { explainModelError, setupLines } from "./explain";
import { featureRow, isCheck, isFeature } from "./features";
import { type ModelFailureRow, modelFailures } from "./schema";

/**
 * The model status of a running deployment (ADR-0009 §13): at start, one log line per kind of
 * model; on each failed call, one sentence that names the setting to fix, logged and kept for the
 * console's Models settings. Started at boot by the open-source edition only: an edition with its
 * own models has its own reporting, and maybe no `model_failures` table.
 */

export interface ModelFailure {
  feature: string;
  kind: "text" | "decision";
  provider: string;
  model: string;
  message: string;
  status?: number;
  /** How many failures this write stands for: itself and those held back since the last. */
  count?: number;
  at?: Date;
}

export interface ModelFailureStore {
  failed(failure: ModelFailure): Promise<void>;
  succeeded(feature: string, at?: Date): Promise<void>;
  list(): Promise<ModelFailureRow[]>;
}

/** The failures in Postgres, one row per feature. */
export function dbModelFailureStore(db: ReturnType<typeof getDb> = getDb()): ModelFailureStore {
  return {
    async failed(failure) {
      const at = failure.at ?? new Date();
      const count = Math.max(1, Math.trunc(failure.count ?? 1));
      const values = {
        kind: failure.kind,
        provider: failure.provider,
        model: failure.model,
        message: failure.message,
        status: failure.status ?? null,
        failedAt: at,
      };
      await db
        .insert(modelFailures)
        .values({ feature: failure.feature, ...values, failures: count })
        .onConflictDoUpdate({
          target: modelFailures.feature,
          set: {
            ...values,
            // A failure after a call that worked starts the count again.
            failures: sql`case when ${modelFailures.okAt} is not null and ${modelFailures.okAt} > ${modelFailures.failedAt} then ${count} else ${modelFailures.failures} + ${count} end`,
          },
        });
    },
    async succeeded(feature, at = new Date()) {
      await db.update(modelFailures).set({ okAt: at }).where(eq(modelFailures.feature, feature));
    },
    async list() {
      return db.select().from(modelFailures).orderBy(desc(modelFailures.failedAt));
    },
  };
}

type Log = (level: "info" | "warn", fields: Record<string, unknown>, message: string) => void;

export interface ModelStatusOptions {
  config?: Config;
  environment?: string;
  store?: ModelFailureStore;
  now?: () => number;
  log?: Log;
}

/**
 * The same failure is logged and written at most this often per feature; those in between are
 * added to the count of the next write. A different failure is news, and is written at once.
 */
const LOG_EVERY_MS = 60_000;
/** A feature's working calls are written at most this often. */
const OK_EVERY_MS = 10 * 60_000;

function defaultLog(): Log {
  const logger = getLogger("models");
  return (level, fields, message) => logger[level](fields, message);
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** Logs the setup, then listens to every model call; returns a function that stops listening. */
export function startModelStatus(options: ModelStatusOptions = {}): () => void {
  const config = options.config ?? getConfig();
  const environment = options.environment ?? deploymentEnvironment();
  const now = options.now ?? Date.now;
  const log = options.log ?? defaultLog();
  let store = options.store;
  const failures = () => {
    store ??= dbModelFailureStore();
    return store;
  };

  for (const line of setupLines(config, environment)) log(line.level, {}, line.message);

  const logged = new Map<string, number>();
  const okWritten = new Map<string, number>();
  /** Per feature: the last failure written, and the failures held back since. */
  const written = new Map<string, { at: number; message: string }>();
  const heldBack = new Map<string, number>();
  return onModelCall((record) => {
    // The console's check reports its own result, on the page that ran it.
    if (isCheck(record.feature)) return;
    if (record.outcome === "ok") {
      // What was held back came before this call: the count starts again after it.
      written.delete(record.feature);
      heldBack.delete(record.feature);
      const last = okWritten.get(record.feature);
      if (last !== undefined && now() - last < OK_EVERY_MS) return;
      okWritten.set(record.feature, now());
      failures()
        .succeeded(record.feature, new Date(now()))
        .catch(() => {});
      return;
    }
    if (record.outcome !== "error") return;
    const kind =
      isFeature(record.feature) && featureRow(record.feature).kind === "decision"
        ? "decision"
        : "text";
    const message = explainModelError(
      { feature: record.feature, model: record.model, error: record.error, kind },
      { config, environment },
    );
    const status = statusOf(record.error);
    const key = `${record.feature}|${message}`;
    const last = logged.get(key);
    if (last === undefined || now() - last >= LOG_EVERY_MS) {
      logged.set(key, now());
      log(
        "warn",
        {
          feature: record.feature,
          provider: record.provider,
          model: record.model,
          ...(status !== undefined ? { status } : {}),
        },
        message,
      );
    }
    // A failure after a success is news again.
    okWritten.delete(record.feature);
    const previous = written.get(record.feature);
    if (previous && previous.message === message && now() - previous.at < LOG_EVERY_MS) {
      heldBack.set(record.feature, (heldBack.get(record.feature) ?? 0) + 1);
      return;
    }
    const count = 1 + (heldBack.get(record.feature) ?? 0);
    heldBack.delete(record.feature);
    written.set(record.feature, { at: now(), message });
    failures()
      .failed({
        feature: record.feature,
        kind,
        provider: record.provider,
        model: record.model,
        message,
        ...(status !== undefined ? { status } : {}),
        ...(count > 1 ? { count } : {}),
        at: new Date(now()),
      })
      .catch(() => {});
  });
}
