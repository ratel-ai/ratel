import assert from "node:assert/strict";
import { test } from "node:test";
import { installStartPath, repositorySettingsPath, setupRedirectPath } from "./paths";

const P = "11111111-1111-4111-8111-111111111111";

test("a good setup lands on the Repository tab with the grant", () => {
  assert.equal(
    setupRedirectPath({ ok: true, projectId: P, grant: "a.b+c" }),
    `${repositorySettingsPath(P)}?grant=a.b%2Bc`,
  );
});

test("a forged or expired state redirects home with the error", () => {
  assert.equal(
    setupRedirectPath({ ok: false, error: "invalid_state" }),
    "/?github_setup_error=invalid_state",
  );
});

test("a later refusal redirects to the project's tab with the error", () => {
  assert.equal(
    setupRedirectPath({ ok: false, error: "unverified_installation", projectId: P }),
    `${repositorySettingsPath(P)}?github_setup_error=unverified_installation`,
  );
});

test("the Install link goes through our route, which sets the state cookie", () => {
  assert.equal(installStartPath(P), `/api/github/install?project=${P}`);
  assert.equal(installStartPath(P, "authorize"), `/api/github/install?project=${P}&mode=authorize`);
});
