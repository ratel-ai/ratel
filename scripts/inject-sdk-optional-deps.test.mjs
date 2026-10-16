import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { injectSdkOptionalDeps } from "./inject-sdk-optional-deps.mjs";

const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64-gnu", "linux-arm64-gnu", "win32-x64-msvc"];

// A minimal repo tree: the SDK loader + 5 platform packages, plus the sibling
// telemetry manifest the loader's workspace: deps resolve against.
function makeRepo({ version = "0.4.0-rc.2", loader = {}, teleVer = "0.1.0-rc.3" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ratel-inject-"));
  const write = (rel, obj) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(obj, null, 2)}\n`);
  };
  write("src/sdk/ts/package.json", { name: "@ratel-ai/sdk", version, ...loader });
  for (const t of PLATFORMS) {
    write(`src/sdk/ts/npm/${t}/package.json`, { name: `@ratel-ai/sdk-${t}`, version });
  }
  write("src/telemetry/ts/package.json", { name: "@ratel-ai/telemetry", version: teleVer });
  return root;
}

const loaderPkg = (root) => JSON.parse(readFileSync(join(root, "src/sdk/ts/package.json"), "utf8"));

test("injects the five platform packages as optionalDependencies at the loader version", () => {
  const root = makeRepo({ version: "0.4.0-rc.2" });
  try {
    injectSdkOptionalDeps(root);
    const opt = loaderPkg(root).optionalDependencies;
    assert.deepEqual(
      Object.keys(opt).sort(),
      PLATFORMS.map((t) => `@ratel-ai/sdk-${t}`).sort(),
    );
    for (const v of Object.values(opt)) assert.equal(v, "0.4.0-rc.2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rewrites workspace: deps and peerDeps to caret ranges on the sibling version", () => {
  const root = makeRepo({
    loader: {
      dependencies: { "@modelcontextprotocol/sdk": "^1.29.0", "@ratel-ai/telemetry": "workspace:^" },
      peerDependencies: { "@ratel-ai/telemetry": "workspace:^" },
    },
    teleVer: "0.1.0-rc.3",
  });
  try {
    injectSdkOptionalDeps(root);
    const pkg = loaderPkg(root);
    assert.equal(pkg.dependencies["@ratel-ai/telemetry"], "^0.1.0-rc.3");
    assert.equal(pkg.peerDependencies["@ratel-ai/telemetry"], "^0.1.0-rc.3");
    // Untouched non-workspace deps stay verbatim.
    assert.equal(pkg.dependencies["@modelcontextprotocol/sdk"], "^1.29.0");
    // No workspace: specifier may survive anywhere.
    const all = JSON.stringify(pkg);
    assert.equal(all.includes("workspace:"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("throws on a workspace: dep with no known sibling manifest", () => {
  const root = makeRepo({
    loader: { dependencies: { "@ratel-ai/mystery": "workspace:^" } },
  });
  try {
    assert.throws(() => injectSdkOptionalDeps(root), /no known manifest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("throws when a platform subpackage version drifts from the loader", () => {
  const root = makeRepo({ version: "0.4.0-rc.2" });
  try {
    writeFileSync(
      join(root, "src/sdk/ts/npm/darwin-arm64/package.json"),
      `${JSON.stringify({ name: "@ratel-ai/sdk-darwin-arm64", version: "0.4.0-rc.1" }, null, 2)}\n`,
    );
    assert.throws(() => injectSdkOptionalDeps(root), /version mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The rankers plugin is a second napi loader with the same layout (ADR-0028).
test("injects another loader's platform packages when given its package dir", () => {
  const root = makeRepo({ version: "0.13.0-rc.12" });
  const write = (rel, obj) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(obj, null, 2)}\n`);
  };
  write("src/rankers/ts/package.json", {
    name: "@ratel-ai/rankers-plugin",
    version: "0.1.0-rc.1",
    peerDependencies: { "@ratel-ai/sdk": "*" },
    devDependencies: { "@ratel-ai/sdk": "workspace:^", vitest: "^4.1.5" },
  });
  for (const t of PLATFORMS) {
    write(`src/rankers/ts/npm/${t}/package.json`, {
      name: `@ratel-ai/rankers-plugin-${t}`,
      version: "0.1.0-rc.1",
    });
  }
  try {
    injectSdkOptionalDeps(root, "src/rankers/ts");
    const pkg = JSON.parse(readFileSync(join(root, "src/rankers/ts/package.json"), "utf8"));
    assert.deepEqual(
      Object.keys(pkg.optionalDependencies).sort(),
      PLATFORMS.map((t) => `@ratel-ai/rankers-plugin-${t}`).sort(),
    );
    // The literal peer is kept; the dev dep's workspace: is pinned.
    assert.equal(pkg.peerDependencies["@ratel-ai/sdk"], "*");
    assert.equal(pkg.devDependencies["@ratel-ai/sdk"], "^0.13.0-rc.12");
    assert.equal(JSON.stringify(pkg).includes("workspace:"), false);
    // The SDK's own manifest is untouched.
    assert.equal(loaderPkg(root).optionalDependencies, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
