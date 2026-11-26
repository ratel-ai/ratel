import assert from "node:assert/strict";
import { test } from "node:test";
import { resetConfigForTests } from "@/config";
import { dbConfigured } from "./request";

test("dbConfigured waits for the request before it reads the gate", async () => {
  const order: string[] = [];
  const answer = await dbConfigured({
    connection: async () => {
      order.push("connection");
    },
    isDbConfigured: () => {
      order.push("gate");
      return true;
    },
  });
  assert.equal(answer, true);
  assert.deepEqual(order, ["connection", "gate"]);
});

test("dbConfigured never reads the gate while the request is pending (a prerender)", async () => {
  let read = false;
  const pending = dbConfigured({
    connection: () => new Promise<void>(() => {}),
    isDbConfigured: () => {
      read = true;
      return false;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(read, false);
  void pending;
});

test("dbConfigured answers database.url outside Next, as isDbConfigured does", async () => {
  const previous = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = "";
    resetConfigForTests();
    assert.equal(await dbConfigured(), false);
    process.env.DATABASE_URL = "postgres://x";
    resetConfigForTests();
    assert.equal(await dbConfigured(), true);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    resetConfigForTests();
  }
});
