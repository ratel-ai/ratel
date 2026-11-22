import type { ToolChannel } from "../tools.js";

/** The tool channel of `ratel sandbox verify --dry`: every fake is a fixed value, no model call. */
export const DRY_FAKE_RESULT = Object.freeze({
  dry: true,
  note: "a fixed fake of ratel sandbox verify --dry",
});

export function dryToolChannel(): ToolChannel {
  return {
    fake: async () => ({ result: DRY_FAKE_RESULT, isError: false, source: "pinned" }),
    confirm: async () => ({ decision: "reject" }),
  };
}
