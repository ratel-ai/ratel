import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Starts the real `ratel dev` from source (under tsx) for tests, with a clean
// environment: only PATH, NO_COLOR and the project key.

const MAIN = fileURLToPath(new URL("../cli/main.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");
/** The twin SDK entry as a file URL, for twin files in throwaway projects. */
export const INDEX = pathToFileURL(fileURLToPath(new URL("../index.ts", import.meta.url))).href;
export const PROJECT_KEY = "rtl_test_project_key_0123456789";

export interface Dev {
  child: ChildProcess;
  stdout(): string;
  waitForOutput(text: string, timeoutMs?: number): Promise<void>;
  exited: Promise<number | null>;
}

export function startRatelDev(cwd: string, url: string, apiKey = PROJECT_KEY): Dev {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NO_COLOR: "1", RATEL_API_KEY: apiKey };
  const child = spawn(process.execPath, ["--import", TSX, MAIN, "dev", "--url", url], { cwd, env });
  let out = "";
  const listeners = new Set<() => void>();
  const onData = (d: Buffer) => {
    out += d;
    for (const l of listeners) l();
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  return {
    child,
    stdout: () => out,
    exited,
    waitForOutput: (text, timeoutMs = 20_000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          if (!out.includes(text)) return;
          listeners.delete(check);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`no "${text}" within ${timeoutMs} ms. Output:\n${out}`));
        }, timeoutMs);
        listeners.add(check);
        check();
      }),
  };
}
