import { createRequire } from "node:module";
import { createServer } from "node:net";

const PLATFORM_MAP: Record<string, string> = {
  darwin: "darwin",
  linux: "linux",
  win32: "win32",
};

const ARCH_MAP: Record<string, string> = {
  arm64: "arm64",
  x64: "x64",
};

export function resolveBinaryPath(): string | null {
  const platform = PLATFORM_MAP[process.platform];
  const arch = ARCH_MAP[process.arch];
  if (!platform || !arch) return null;

  const packageName = `@agentified/core-${platform}-${arch}`;
  try {
    const require = createRequire(import.meta.url);
    return require.resolve(packageName);
  } catch {
    return null;
  }
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to get port")));
      }
    });
    server.on("error", reject);
  });
}
