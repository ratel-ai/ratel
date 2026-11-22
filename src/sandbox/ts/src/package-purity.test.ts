import { readFileSync } from "node:fs";
import net from "node:net";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// The production import path (`@ratel-ai/sandbox`) runs inside the user's agent in
// production, so it must stay pure: no socket, no HTTP, no child process. The
// runner and the CLI (src/cli, the `ratel` bin) live behind their own entrypoints. This walks the real
// module graph of the root entry, then imports it and watches for a socket.

const ALLOWED = ["@opentelemetry/api", "node:crypto", "node:path"];

describe("@ratel-ai/sandbox entry stays network-free", () => {
  it("reaches only the allowed packages from index.ts", () => {
    expect([...packagesReachableFrom("index.ts")].sort()).toEqual(ALLOWED);
  });

  it("keeps ai out of the core: only the ai-sdk entry names it, as a type", () => {
    // node:fs, node:path and node:url find `ai` and the providers in the user's project.
    expect([...packagesReachableFrom("ai-sdk.ts")].sort()).toEqual([
      "@opentelemetry/api",
      "ai",
      "node:fs",
      "node:path",
      "node:url",
    ]);
    const source = readFileSync(new URL("ai-sdk.ts", import.meta.url), "utf8");
    expect(source).toMatch(/^import type \{[^}]*\} from "ai";$/m);
  });

  it("opens no socket and calls no fetch on import", async () => {
    const connect = vi.spyOn(net.Socket.prototype, "connect");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.resetModules();
    const mod = await import("./index.js");
    expect(typeof mod.sandbox).toBe("function");
    expect(connect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    connect.mockRestore();
    fetchSpy.mockRestore();
  });

  it("keeps the test doubles out of the build and publishes under MIT", () => {
    const tsconfig = JSON.parse(readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8"));
    expect(tsconfig.exclude).toContain("src/test-support/**/*");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    // CLI only, never reached from the entry: tsx loads user sandboxes in the child
    // worker, ws holds the `ratel sandbox dev` socket, and the OpenTelemetry SDK and
    // OTLP exporter send playground traces from the `ratel sandbox dev` child.
    expect(pkg.dependencies ?? {}).toEqual({
      "@opentelemetry/exporter-trace-otlp-http": "^0.220.0",
      "@opentelemetry/resources": "^2.9.0",
      "@opentelemetry/sdk-trace-node": "^2.9.0",
      tsx: "^4.21.0",
      ws: "^8.21.1",
    });
    expect(pkg.bin).toEqual({ ratel: "./dist/cli/main.js" });
    // The AI SDK packages are optional peers: the ai-sdk entry imports the ones the project has, at run time.
    expect(pkg.peerDependencies).toEqual({
      "@ai-sdk/anthropic": "^3.0.0 || ^4.0.0",
      "@ai-sdk/google": "^3.0.0 || ^4.0.0",
      "@ai-sdk/openai": "^3.0.0 || ^4.0.0",
      "@opentelemetry/api": "^1.9.0",
      ai: "^6.0.0 || ^7.0.0",
    });
    for (const name of ["ai", "@ai-sdk/anthropic", "@ai-sdk/google", "@ai-sdk/openai"])
      expect(pkg.peerDependenciesMeta[name]).toEqual({ optional: true });
    expect(pkg.exports["./ai-sdk"]).toEqual({
      types: "./dist/ai-sdk.d.ts",
      default: "./dist/ai-sdk.js",
    });
    expect(pkg.license).toBe("MIT");
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
  });
});

function packagesReachableFrom(entry: string): Set<string> {
  const visited = new Set<string>();
  const packages = new Set<string>();
  const queue = [new URL(entry, import.meta.url)];
  while (queue.length > 0) {
    const file = queue.shift() as URL;
    if (visited.has(file.href)) continue;
    visited.add(file.href);
    for (const specifier of specifiersIn(file)) {
      if (specifier.startsWith(".")) queue.push(new URL(specifier.replace(/\.js$/, ".ts"), file));
      else packages.add(specifier);
    }
  }
  return packages;
}

function specifiersIn(file: URL): string[] {
  const source = ts.createSourceFile(
    file.pathname,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}
