import assert from "node:assert/strict";
import { test } from "node:test";
import { appConfigScript, resolveAppConfig } from "./app-config";

test("the defaults are local development on the open-source edition", () => {
  assert.deepEqual(resolveAppConfig({}), {
    name: "Ratel",
    baseUrl: "http://localhost:3000/api/v1",
  });
});

test("the environment overrides both; a blank value is the default; no trailing slash", () => {
  assert.deepEqual(
    resolveAppConfig({ APP_NAME: "Ratel Cloud", BASE_URL: "https://ratel.example.com/api/v1/" }),
    { name: "Ratel Cloud", baseUrl: "https://ratel.example.com/api/v1" },
  );
  assert.deepEqual(resolveAppConfig({ APP_NAME: "  ", BASE_URL: "" }), {
    name: "Ratel",
    baseUrl: "http://localhost:3000/api/v1",
  });
});

test("the browser script cannot break out of its tag", () => {
  const script = appConfigScript({ name: "</script><b>", baseUrl: "http://x" });
  assert.equal(script.includes("</script>"), false);
  assert.match(script, /^window\.__RATEL_APP_CONFIG__=/);
});
