import assert from "node:assert/strict";
import { test } from "node:test";
import { VariantMappingsSection } from "@/components/console/settings/VariantMappingsSection";

/** RC-869: the section shows only with `FF_VARIANT_EXPERIMENTS` on; unset, it is off. */

test("with the switch off the section renders nothing and reads no mapping", async () => {
  const saved = process.env.FF_VARIANT_EXPERIMENTS;
  delete process.env.FF_VARIANT_EXPERIMENTS;
  try {
    const organization = { id: "22222222-2222-4222-8222-222222222222" };
    assert.equal(
      await VariantMappingsSection({
        projectId: "11111111-1111-4111-8111-111111111111",
        organization,
      }),
      null,
    );
  } finally {
    if (saved !== undefined) process.env.FF_VARIANT_EXPERIMENTS = saved;
  }
});
