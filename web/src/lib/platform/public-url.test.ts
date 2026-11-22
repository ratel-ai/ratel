import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { isOwnOrigin, publicBaseUrl, redirectUrl } from "@/lib/platform/public-url";

const saved = process.env.APP_PUBLIC_URL;
const savedEnv = process.env.APP_ENV;

function restore() {
  if (saved === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = saved;
  if (savedEnv === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = savedEnv;
}

describe("publicBaseUrl", () => {
  afterEach(restore);

  it("falls back to localhost on a laptop", () => {
    delete process.env.APP_PUBLIC_URL;
    delete process.env.APP_ENV;
    assert.equal(publicBaseUrl(), "http://localhost:3000");
  });

  it("throws in a deployed environment rather than hand out localhost links", () => {
    delete process.env.APP_PUBLIC_URL;
    for (const env of ["production", "staging"]) {
      process.env.APP_ENV = env;
      assert.throws(() => publicBaseUrl(), /APP_PUBLIC_URL/);
      assert.throws(() => redirectUrl("/admin", "https://ip-10-0-1-5:3000/x"), /APP_PUBLIC_URL/);
    }
  });
});

describe("redirectUrl", () => {
  afterEach(restore);

  it("points at the public origin, not the container address Next puts in request.url", () => {
    process.env.APP_PUBLIC_URL = "https://cloud.ratel.sh/";
    const url = redirectUrl(
      "/admin?x=1",
      "https://ip-10-60-10-130.eu-central-1.compute.internal:3000/api/support-session/end",
    );
    assert.equal(url.href, "https://cloud.ratel.sh/admin?x=1");
  });

  it("falls back to the request's own origin when nothing is configured", () => {
    delete process.env.APP_PUBLIC_URL;
    assert.equal(
      redirectUrl("/admin", "http://localhost:3005/api/x").href,
      "http://localhost:3005/admin",
    );
  });
});

describe("isOwnOrigin", () => {
  afterEach(() => {
    if (saved === undefined) delete process.env.APP_PUBLIC_URL;
    else process.env.APP_PUBLIC_URL = saved;
  });

  it("accepts the public origin when the request URL is the container's address", () => {
    process.env.APP_PUBLIC_URL = "https://cloud.ratel.sh/";
    assert.equal(
      isOwnOrigin("https://cloud.ratel.sh", "http://ip-10-0-1-5:3000/api/agent-health/imports"),
      true,
    );
  });

  it("accepts the request URL's own origin", () => {
    process.env.APP_PUBLIC_URL = "https://cloud.ratel.sh";
    assert.equal(
      isOwnOrigin("http://localhost:3000", "http://localhost:3000/api/agent-health/imports"),
      true,
    );
  });

  it("rejects any other site", () => {
    process.env.APP_PUBLIC_URL = "https://cloud.ratel.sh";
    assert.equal(
      isOwnOrigin("https://evil.example", "http://ip-10-0-1-5:3000/api/agent-health/imports"),
      false,
    );
    assert.equal(
      isOwnOrigin("https://cloud.ratel.sh.evil.example", "http://ip-10-0-1-5:3000/x"),
      false,
    );
  });
});
