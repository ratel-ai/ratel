import assert from "node:assert/strict";
import { test } from "node:test";
import type { tourStatusCookie } from "@/lib/console/onboarding/tour-cookie";
import { readTourStatus, saveTourStatus } from "@/lib/console/onboarding/tour-status";
import type { TourStatusStore } from "@/lib/contracts/session";

function cookieJar(initial?: string) {
  const jar = { value: initial, writes: 0 };
  return {
    jar,
    cookie: {
      current: () => jar.value,
      write: (cookie: ReturnType<typeof tourStatusCookie>) => {
        jar.value = cookie.value;
        jar.writes += 1;
      },
      secure: false,
    },
  };
}

function edition(initial: string | null = null) {
  const store = { value: initial, writes: [] as string[] };
  const port: TourStatusStore = {
    read: async () => store.value,
    write: async (status) => {
      store.writes.push(status);
      store.value = status;
    },
  };
  return { store, port };
}

test("with the edition's store the status is the account's, and the cookie is neither read nor written", async () => {
  const { jar, cookie } = cookieJar("skipped");
  const { store, port } = edition("completed");
  assert.equal(await readTourStatus({ edition: port, cookie: cookie.current }), "completed");
  await saveTourStatus("skipped", { edition: port, cookie });
  assert.deepEqual(store.writes, ["skipped"]);
  assert.deepEqual(jar, { value: "skipped", writes: 0 });
});

test("an account that never finished the tour reads as nothing, whatever the browser holds", async () => {
  const { cookie } = cookieJar("completed");
  assert.equal(await readTourStatus({ edition: edition(null).port, cookie: cookie.current }), null);
});

test("without an edition the status stays a per-browser cookie, as before", async () => {
  const { jar, cookie } = cookieJar();
  assert.equal(await readTourStatus({ cookie: cookie.current }), undefined);
  await saveTourStatus("completed", { cookie });
  assert.equal(await readTourStatus({ cookie: cookie.current }), "completed");
  await saveTourStatus("completed", { cookie });
  assert.equal(jar.writes, 1, "an unchanged status is not written again");
});
