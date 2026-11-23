import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  MODEL_PRICING_ERRORS,
  type ModelPricingDeps,
  resetProjectModelPrice,
  saveProjectModelPrice,
} from "./settings";
import { loadPriceOverrides } from "./store";

/** RC-482: only an admin sets a project's model prices, with the flag on; each change re-prices that model. */

const ORG = "22222222-2222-4222-8222-222222222221";
const PROJECT = "11111111-1111-4111-8111-111111111111";

type Db = ReturnType<typeof getDb>;

async function setup(): Promise<{ client: PGlite; db: Db }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Org', 'org');
    insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'A', 'a');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as Db };
}

function deps(db: Db, role: string | null, options: { restricted?: boolean } = {}) {
  const log = { tracked: [] as unknown[], repriced: [] as string[] };
  const value: ModelPricingDeps = {
    db,
    getActor: async () => ({ userId: "u1", externalId: "user_1" }),
    findRole: async () => role,
    isRestricted: async () => options.restricted ?? false,
    reprice: (projectId, model) => {
      log.repriced.push(`${projectId}:${model}`);
    },
    track: async (event) => {
      log.tracked.push(event);
    },
  };
  return { deps: value, log };
}

test("an admin saves and resets a model price, and each change re-prices the model", async () => {
  const { client, db } = await setup();
  try {
    const admin = deps(db, "admin");
    const saved = await saveProjectModelPrice(
      PROJECT,
      { model: "gpt-4o", input: "2", output: "8" },
      admin.deps,
    );
    assert.deepEqual(saved, { ok: true, model: "gpt-4o" });
    assert.deepEqual(await loadPriceOverrides(PROJECT, db), { "gpt-4o": { input: 2, output: 8 } });

    assert.deepEqual(await resetProjectModelPrice(PROJECT, "gpt-4o", admin.deps), {
      ok: true,
      model: "gpt-4o",
    });
    assert.deepEqual(await loadPriceOverrides(PROJECT, db), {});
    assert.deepEqual(admin.log.repriced, [`${PROJECT}:gpt-4o`, `${PROJECT}:gpt-4o`]);
    assert.deepEqual(admin.log.tracked, [
      { externalId: "user_1", projectId: PROJECT, model: "gpt-4o", action: "saved" },
      { externalId: "user_1", projectId: PROJECT, model: "gpt-4o", action: "reset" },
    ]);
  } finally {
    await client.close();
  }
});

test("a bad price is refused with the field to fix, and nothing is saved", async () => {
  const { client, db } = await setup();
  try {
    const admin = deps(db, "admin");
    assert.deepEqual(
      await saveProjectModelPrice(
        PROJECT,
        { model: "gpt-4o", input: "-1", output: "8" },
        admin.deps,
      ),
      {
        ok: false,
        field: "input",
        error: "Enter a price of 0 or more.",
      },
    );
    assert.deepEqual(await loadPriceOverrides(PROJECT, db), {});
    assert.deepEqual(admin.log.repriced, []);
  } finally {
    await client.close();
  }
});

test("a member, a non-member and a support session are refused", async () => {
  const { client, db } = await setup();
  try {
    const input = { model: "gpt-4o", input: "2", output: "8" };
    assert.deepEqual(await saveProjectModelPrice(PROJECT, input, deps(db, "member").deps), {
      ok: false,
      error: MODEL_PRICING_ERRORS.not_admin,
    });
    assert.deepEqual(await saveProjectModelPrice(PROJECT, input, deps(db, null).deps), {
      ok: false,
      error: MODEL_PRICING_ERRORS.not_found,
    });
    assert.deepEqual(
      await resetProjectModelPrice(PROJECT, "gpt-4o", deps(db, "admin", { restricted: true }).deps),
      {
        ok: false,
        error: MODEL_PRICING_ERRORS.restricted,
      },
    );
    assert.deepEqual(await loadPriceOverrides(PROJECT, db), {});
  } finally {
    await client.close();
  }
});
