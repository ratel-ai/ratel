import assert from "node:assert/strict";
import { test } from "node:test";
import { bootPlan } from "./boot-plan";

const DB = { DATABASE_URL: "postgres://localhost/ratel" };

test("with no APP_ROLE one process migrates and ticks in process, as before", () => {
  assert.deepEqual(bootPlan(DB), { role: "all", migrate: true, tick: "scheduler" });
  assert.deepEqual(bootPlan({ ...DB, RATEL_CRON: "inprocess", APP_ROLE: "both" }), {
    role: "all",
    migrate: true,
    tick: "scheduler",
  });
});

test("with an external scheduler the all-in-one process leaves the tick to its caller", () => {
  assert.equal(bootPlan({ ...DB, RATEL_CRON: "external" }).tick, "external");
  assert.equal(bootPlan({ ...DB, RATEL_COMPOSITION: "cloud" }).tick, "external");
});

test("an API-only process migrates and runs no tick in either cron mode", () => {
  assert.deepEqual(bootPlan({ ...DB, APP_ROLE: "api" }), {
    role: "api",
    migrate: true,
    tick: "none",
  });
  assert.equal(bootPlan({ ...DB, APP_ROLE: "api", RATEL_CRON: "inprocess" }).tick, "none");
  assert.equal(bootPlan({ ...DB, APP_ROLE: "api", RATEL_CRON: "external" }).tick, "none");
});

test("the worker is its own clock in either cron mode and never migrates", () => {
  assert.deepEqual(bootPlan({ ...DB, APP_ROLE: "worker" }), {
    role: "worker",
    migrate: false,
    tick: "worker",
  });
  assert.equal(bootPlan({ ...DB, APP_ROLE: "worker", RATEL_CRON: "external" }).tick, "worker");
  assert.equal(
    bootPlan({ ...DB, APP_ROLE: "worker", DATABASE_MIGRATE_ON_BOOT: "1" }).migrate,
    false,
    "the flag does not make a worker migrate",
  );
});

test("the migration flag still decides for the processes that may migrate", () => {
  assert.equal(bootPlan({ ...DB, DATABASE_MIGRATE_ON_BOOT: "0" }).migrate, false);
  assert.equal(bootPlan({ ...DB, APP_ROLE: "api", DATABASE_MIGRATE_ON_BOOT: "0" }).migrate, false);
  assert.equal(bootPlan({ ...DB, RATEL_COMPOSITION: "cloud" }).migrate, false);
  assert.equal(bootPlan({}).migrate, false, "never without a database");
});
