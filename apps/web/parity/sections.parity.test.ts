import { ANALYSIS_SECTIONS } from "@/lib/views/freshness/sections";
import { parity } from "./ledger";
import { golden, same } from "./support";

// Item 11: the background jobs behind each analysis page.

parity(11, "each analysis page waits on the jobs Cloud's waits on", () => {
  same(ANALYSIS_SECTIONS, golden("analysis-sections"));
});
