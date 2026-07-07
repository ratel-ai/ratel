import { describe, expect, it } from "vitest";
import { resolveSourceConfig } from "./index.js";

describe("resolveSourceConfig", () => {
  it("returns undefined with no options and no env — the embedded floor", () => {
    expect(resolveSourceConfig(undefined, {})).toBeUndefined();
    expect(resolveSourceConfig({}, {})).toBeUndefined();
  });

  it("resolves url and apiKey from the env", () => {
    const config = resolveSourceConfig(undefined, {
      RATEL_URL: "https://cloud.ratel.sh",
      RATEL_API_KEY: "rk_env",
    });
    expect(config).toEqual({ url: "https://cloud.ratel.sh", apiKey: "rk_env" });
  });

  it("explicit options beat the env", () => {
    const config = resolveSourceConfig(
      { url: "https://self-hosted.example", apiKey: "rk_opt" },
      { RATEL_URL: "https://cloud.ratel.sh", RATEL_API_KEY: "rk_env" },
    );
    expect(config).toEqual({ url: "https://self-hosted.example", apiKey: "rk_opt" });
  });

  it("mixes an env url with an explicit apiKey (and vice versa)", () => {
    expect(
      resolveSourceConfig({ apiKey: "rk_opt" }, { RATEL_URL: "https://cloud.ratel.sh" }),
    ).toEqual({ url: "https://cloud.ratel.sh", apiKey: "rk_opt" });
    expect(
      resolveSourceConfig({ url: "https://self-hosted.example" }, { RATEL_API_KEY: "rk_env" }),
    ).toEqual({ url: "https://self-hosted.example", apiKey: "rk_env" });
  });

  it("returns undefined when only an apiKey is available — a key names no source", () => {
    expect(resolveSourceConfig({ apiKey: "rk_opt" }, { RATEL_API_KEY: "rk_env" })).toBeUndefined();
  });

  it("passes scope through from options only", () => {
    const config = resolveSourceConfig({ scope: "alice" }, { RATEL_URL: "https://cloud.ratel.sh" });
    expect(config).toEqual({ url: "https://cloud.ratel.sh", scope: "alice" });
  });

  it("omits apiKey and scope when they resolve to nothing", () => {
    const config = resolveSourceConfig({ url: "https://cloud.ratel.sh" }, {});
    expect(config).toEqual({ url: "https://cloud.ratel.sh" });
    expect(config && "apiKey" in config).toBe(false);
    expect(config && "scope" in config).toBe(false);
  });
});
