import { describe, expect, it } from "vitest";
import {
  EXECUTE_TOOL,
  RATEL_AUTH_FLOW,
  RATEL_SEARCH,
  RATEL_SKILL_LOAD,
  RATEL_UPSTREAM_REGISTER,
  SEMCONV_VERSION,
} from "./index.js";

describe("ratel telemetry vocabulary", () => {
  it("pins the OTel gen_ai semconv version", () => {
    expect(SEMCONV_VERSION).toBe("1.42.0");
  });

  it("names the ratel.* spans per the pin", () => {
    expect(RATEL_SEARCH).toBe("ratel.search");
    expect(RATEL_SKILL_LOAD).toBe("ratel.skill.load");
    expect(RATEL_UPSTREAM_REGISTER).toBe("ratel.upstream.register");
    expect(RATEL_AUTH_FLOW).toBe("ratel.auth.flow");
  });

  it("models tool invocation as the gen_ai execute_tool operation, not ratel.invoke", () => {
    expect(EXECUTE_TOOL).toBe("execute_tool");
    expect(EXECUTE_TOOL).not.toBe("ratel.invoke");
  });
});
