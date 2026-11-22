import assert from "node:assert/strict";
import { test } from "node:test";
import { appAuthorizeUrl, appInstallUrl, readGitHubAppConfig } from "./config";

const FULL = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "ratel-dev",
  GITHUB_APP_PRIVATE_KEY: "pem",
  GITHUB_WEBHOOK_SECRET: "s",
  GITHUB_APP_CLIENT_ID: "Iv1.c",
  GITHUB_APP_CLIENT_SECRET: "cs",
};

test("reads the six values", () => {
  assert.deepEqual(readGitHubAppConfig(FULL), {
    appId: "1",
    slug: "ratel-dev",
    privateKey: "pem",
    webhookSecret: "s",
    clientId: "Iv1.c",
    clientSecret: "cs",
  });
});

test("a missing client id or client secret is not configured, not an error", () => {
  assert.equal(readGitHubAppConfig({ ...FULL, GITHUB_APP_CLIENT_ID: undefined }), null);
  assert.equal(readGitHubAppConfig({ ...FULL, GITHUB_APP_CLIENT_SECRET: "REPLACE_ME" }), null);
});

test("is not configured when any value is missing or blank", () => {
  for (const name of Object.keys(FULL)) {
    assert.equal(readGitHubAppConfig({ ...FULL, [name]: undefined }), null, name);
    assert.equal(readGitHubAppConfig({ ...FULL, [name]: "  " }), null, name);
    assert.equal(readGitHubAppConfig({ ...FULL, [name]: "REPLACE_ME" }), null, name);
  }
  assert.equal(readGitHubAppConfig({}), null);
});

test("the install link carries the state", () => {
  assert.equal(
    appInstallUrl({ slug: "ratel-dev" }, "a.b"),
    "https://github.com/apps/ratel-dev/installations/new?state=a.b",
  );
});

test("the authorize link carries the client id and the state", () => {
  assert.equal(
    appAuthorizeUrl({ clientId: "Iv1.c" }, "a.b"),
    "https://github.com/login/oauth/authorize?client_id=Iv1.c&state=a.b",
  );
});
