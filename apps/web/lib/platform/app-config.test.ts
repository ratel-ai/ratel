import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APP_NAME,
  apiUrl,
  appConfigScript,
  editionServiceName,
  resolveAppConfig,
  serviceName,
  setEditionServiceName,
} from "./app-config";

test("the defaults are local development on the open-source edition", () => {
  assert.deepEqual(resolveAppConfig({}), {
    name: "Ratel",
    baseUrl: "http://localhost:3000",
  });
});

test("the environment overrides both; a blank value is the default; no trailing slash", () => {
  assert.deepEqual(
    resolveAppConfig({ APP_NAME: "Ratel Cloud", BASE_URL: "https://ratel.example.com/" }),
    { name: "Ratel Cloud", baseUrl: "https://ratel.example.com" },
  );
  assert.deepEqual(resolveAppConfig({ APP_NAME: "  ", BASE_URL: "" }), {
    name: "Ratel",
    baseUrl: "http://localhost:3000",
  });
});

test("a value that still ends in /api/v1 is stripped to the origin", () => {
  assert.deepEqual(resolveAppConfig({ BASE_URL: "https://ratel.example.com/api/v1/" }), {
    name: "Ratel",
    baseUrl: "https://ratel.example.com",
  });
  assert.deepEqual(resolveAppConfig({ BASE_URL: "http://localhost:3000/api/v1" }), {
    name: "Ratel",
    baseUrl: "http://localhost:3000",
  });
});

test("apiUrl builds absolute URLs under /api/v1", () => {
  assert.equal(apiUrl(), "http://localhost:3000/api/v1");
  assert.equal(apiUrl("/traces"), "http://localhost:3000/api/v1/traces");
  assert.equal(apiUrl("intent-graph"), "http://localhost:3000/api/v1/intent-graph");
});

test("the browser script cannot break out of its tag", () => {
  const script = appConfigScript({ name: "</script><b>", baseUrl: "http://x" });
  assert.equal(script.includes("</script>"), false);
  assert.match(script, /^window\.__RATEL_APP_CONFIG__=/);
});

test("without an edition's short name, a sentence names the service APP_NAME", () => {
  assert.equal(editionServiceName(), null);
  assert.equal(serviceName(), APP_NAME);
  assert.doesNotMatch(appConfigScript(), /serviceName/);
});

test("an edition's short name names the service, and the browser is handed it", (t) => {
  setEditionServiceName("Cloud");
  t.after(() => setEditionServiceName(undefined));
  assert.equal(editionServiceName(), "Cloud");
  assert.equal(serviceName(), "Cloud");
  assert.match(appConfigScript(), /"serviceName":"Cloud"/);
});
