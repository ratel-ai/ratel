import { CAPTURE_DIFF_LINES } from "@/components/console/health/capture-nudge-model";
import { TOOL_CATALOG_SNIPPET } from "@/lib/console/catalog/sync-snippet";
import { buildQuickstartSet } from "@/lib/console/onboarding/quickstart";
import { QUICKSTART_TARGET } from "./inputs";
import { parity } from "./ledger";
import { snippet } from "./normalise";
import { golden, same } from "./support";

// Items 15 and 22: the snippets the console hands out.

interface CloudSnippets {
  toolCatalog: string;
  nudgeContextInQuickstart: { text: string; inQuickstart: boolean }[];
}
const cloud = golden<CloudSnippets>("snippets");

parity(15, "the catalog's \"Register tools with the SDK\" snippet is Cloud's", () => {
  same(snippet(TOOL_CATALOG_SNIPPET), snippet(cloud.toolCatalog));
});

parity(22, "the capture nudge's unchanged lines are lines of the quickstart, as on Cloud", () => {
  const quickstart = new Set(
    buildQuickstartSet({ ...QUICKSTART_TARGET, captureContent: true }).typescript.code.split("\n"),
  );
  const context = CAPTURE_DIFF_LINES.filter((line) => !line.added && line.text.trim() !== "");
  same(
    context.map((line) => quickstart.has(line.text)),
    cloud.nudgeContextInQuickstart.map((line) => line.inQuickstart),
  );
});
