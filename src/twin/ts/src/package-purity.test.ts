import { readFileSync } from "node:fs";
import net from "node:net";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// The production import path (`@ratel-ai/twin`) runs inside the user's agent in
// production, so it must stay pure: no socket, no HTTP, no child process. The
// runner and the CLI (src/cli, the `ratel` bin) live behind their own entrypoints. This walks the real
// module graph of the root entry, then imports it and watches for a socket.

const ALLOWED = ["@opentelemetry/api", "node:crypto"];

describe("@ratel-ai/twin entry stays network-free", () => {
  it("reaches only the allowed packages from index.ts", () => {
    expect([...packagesReachableFrom("index.ts")].sort()).toEqual(ALLOWED);
  });

  it("opens no socket and calls no fetch on import", async () => {
    const connect = vi.spyOn(net.Socket.prototype, "connect");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.resetModules();
    const mod = await import("./index.js");
    expect(typeof mod.twin).toBe("function");
    expect(connect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    connect.mockRestore();
    fetchSpy.mockRestore();
  });

  it("keeps the test doubles out of the build and publishes under MIT", () => {
    const tsconfig = JSON.parse(readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8"));
    expect(tsconfig.exclude).toContain("src/test-support/**/*");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    // CLI only, never reached from the entry: tsx loads user twins in the child
    // worker, ws holds the `ratel dev` socket, and the OpenTelemetry SDK and
    // OTLP exporter send playground traces from the `ratel dev` child.
    expect(pkg.dependencies ?? {}).toEqual({
      "@opentelemetry/exporter-trace-otlp-http": "^0.220.0",
      "@opentelemetry/resources": "^2.9.0",
      "@opentelemetry/sdk-trace-node": "^2.9.0",
      tsx: "^4.21.0",
      ws: "^8.21.1",
    });
    expect(pkg.bin).toEqual({ ratel: "./dist/cli/main.js" });
    expect(pkg.peerDependencies).toEqual({ "@opentelemetry/api": "^1.9.0" });
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
