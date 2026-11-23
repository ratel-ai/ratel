import assert from "node:assert/strict";
import { test } from "node:test";
import { hallucinationsHref } from "@/lib/views/health/hallucinations/paths";

test("a turn opened beside the list is in the address, with the call it is about", () => {
  assert.equal(
    hallucinationsHref("p1", { open: "unknown_reference", turn: "t-1", call: "c-1" }),
    "/project/p1/health/hallucinations?open=unknown_reference&turn=t-1&call=c-1",
  );
});
