import { NO_PRICE, type RoundTripPrice } from "@/lib/synthesis/tool-crafter/round-trip";
import type { CraftCardModel } from "@/lib/synthesis/tool-crafter/view";
import { buildFixes, type FixesInput } from "@/lib/views/fixes/build";
import { craftDraft } from "@/lib/views/fixes/craft-drafts";
import { GAINS, SAVINGS, SAVINGS_PERIOD_KEYS } from "./inputs";
import { parity } from "./ledger";
import { golden, load, plain, revive, same } from "./support";

// Items 1 and 16: Fixes. Cloud's own fixture project goes through this repository's path for a
// drafted change (the crafter's card, told as a draft, then built), and the model that comes out
// is compared with the one Cloud built from the same input.

interface CloudInput extends Omit<FixesInput, "names" | "drafts"> {
  names: ReadonlyMap<string, string>;
  crafts: (Omit<CraftCardModel, "createdAt"> & { createdAt: string; windowDays?: number | null })[];
  price?: RoundTripPrice;
}
interface Model {
  open: { id: string; title: string; effect: unknown; gain: unknown; rank: unknown }[];
  stats: unknown;
}
const cloud =
  golden<Record<"base" | "priced" | "worseMerge", { input: unknown; model: Model }>>("fixes");

/** Cloud's input, built by this repository. Everything Cloud was given is handed over. */
function build(stored: unknown): Model {
  const { crafts, price, ...input } = revive<CloudInput>(stored);
  const name = (id: string) => input.names.get(id) ?? id;
  const drafts = crafts.map((craft) =>
    craftDraft(
      { ...craft, createdAt: new Date(craft.createdAt) } as CraftCardModel,
      name,
      price ?? NO_PRICE,
    ),
  );
  return plain(buildFixes({ ...input, drafts })) as Model;
}

const titles = (model: Model) => model.open.map((fix) => fix.title);

parity(1, "the fixture project's fixes carry Cloud's effect and savings", () => {
  same(build(cloud.priced.input), cloud.priced.model);
});

parity(1, "the fixture project's fixes are Cloud's when nothing is priced", () => {
  same(build(cloud.base.input), cloud.base.model);
});

parity(1, "savingsForPeriod scales measured totals as Cloud does", async () => {
  const { savingsForPeriod } = await load<{
    savingsForPeriod: (s: unknown, d: number | null, p: string) => unknown;
  }>("@/lib/views/fixes/period");
  const table = SAVINGS.flatMap(({ savings, windowDays }) =>
    SAVINGS_PERIOD_KEYS.map((period) => ({
      savings,
      windowDays,
      period,
      result: savingsForPeriod(savings, windowDays, period),
    })),
  );
  same(plain(table), golden<{ savingsForPeriod: unknown }>("savings").savingsForPeriod);
});

parity(1, "fixSavingsText tells a fix's gain as Cloud does", async () => {
  const { fixSavingsText } = await load<{
    fixSavingsText: (g: unknown, p: string) => string | null;
  }>("@/lib/views/fixes/period");
  const table = GAINS.flatMap((gain) =>
    SAVINGS_PERIOD_KEYS.map((period) => ({ gain, period, result: fixSavingsText(gain, period) })),
  );
  same(plain(table), golden<{ fixSavingsText: unknown }>("savings").fixSavingsText);
});

parity(16, "a merge whose replay came out worse is ranked where Cloud ranks it", () => {
  same(titles(build(cloud.worseMerge.input)), titles(cloud.worseMerge.model));
});
