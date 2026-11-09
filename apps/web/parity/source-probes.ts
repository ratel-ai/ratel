/**
 * Facts read off the source of a page or a boot file (temporary parity harness, RTL-45). Some of
 * the audit's items are about what a server component renders or what a boot hook calls, which a
 * unit test cannot run without a database and a session. For those, one small function reads the
 * fact off the file, and the same function runs on Cloud's file (at capture) and on this
 * repository's file (in the test). The rendered result is what `side-by-side.sh` compares.
 *
 * Every probe is written against Cloud's path. This repository's tree translates the path through
 * `normalise.ts` (`ossFiles`), so a probe never names two files.
 */

export interface SourceTree {
  /** The text of the file or files a Cloud path stands for, joined; empty when none exists. */
  read(cloudPath: string): string;
}

type Fact = string | number | boolean | null | readonly string[];

export interface SourceProbe {
  /** The audit item it belongs to. */
  item: number;
  /** What the fact says when it holds. */
  claim: string;
  fact(tree: SourceTree): Fact;
}

const has = (text: string, pattern: RegExp): boolean => pattern.test(text);

/** Job kinds whose handler runs inside the project log context. */
function wrappedJobKinds(text: string): string[] {
  const kinds = new Set<string>();
  const pattern =
    /\b([a-z_]+):\s*(?:\(job\)\s*=>\s*)?(?:inProjectLogContext|withProjectLogContext)\(/g;
  for (const match of text.matchAll(pattern)) kinds.add(match[1]);
  return [...kinds].sort();
}

/** Whether a call sits in its own resilient read, apart from the proposals read before it. */
function adoptionReadApart(text: string): boolean {
  const adoption = text.indexOf("getRuntimeCatalogOverrideAdoption(");
  if (adoption < 0) return false;
  const proposals = text.lastIndexOf("listProposals(", adoption);
  if (proposals < 0) return true;
  // A `read(` or `read<…>(` between the two starts a separate read with its own fallback.
  return /\bread(?:<[^(]*>)?\(/.test(text.slice(proposals, adoption));
}

export const SOURCE_PROBES = {
  selfTelemetryAtBoot: {
    item: 3,
    claim: "The boot hook resolves the self-telemetry configuration and registers the exporters.",
    fact: (tree) =>
      has(
        tree.read("instrumentation.ts") + tree.read("instrumentation.node.ts"),
        /resolveSelfTelemetryConfig\(/,
      ),
  },
  sidebarFreshness: {
    item: 4,
    claim: 'The sidebar renders the "Analysis updated … ago" line.',
    fact: (tree) => has(tree.read("components/shell/Sidebar.tsx"), /<AnalysisFreshness\b/),
  },
  overviewOffersTour: {
    item: 5,
    claim: "Project home decides whether to offer the guided tour.",
    fact: (tree) => has(tree.read("app/(app)/project/[projectId]/page.tsx"), /\bofferTour=/),
  },
  apiKeysQuickstart: {
    item: 6,
    claim: "Settings › API keys renders the quickstart under the key list.",
    fact: (tree) =>
      has(tree.read("components/settings/v2/ApiKeysSettings.tsx"), /<SdkQuickstart\b/),
  },
  turnPageRunToTest: {
    item: 7,
    claim: 'A turn page offers "run to test" behind the eval gate.',
    fact: (tree) => {
      const text = tree.read("app/(app)/project/[projectId]/traces/turns/[turnId]/page.tsx");
      return has(text, /<RunToTest\b/) && has(text, /evalGate/i);
    },
  },
  spanInspectorSdkEvents: {
    item: 9,
    claim: "The trace span inspector is given the SDK events page to link to.",
    fact: (tree) => {
      const text = tree.read("app/(app)/project/[projectId]/traces/[traceId]/trace-v2.tsx");
      const prop = text.match(/runtimeEventsRoot=\{([^}]*)\}/)?.[1]?.trim();
      return prop !== undefined && prop !== "null";
    },
  },
  sdkEventsOpenTrace: {
    item: 9,
    claim: "Settings › Developer builds each SDK event's trace link.",
    fact: (tree) => {
      const text = tree.read("components/settings/v2/DeveloperSettings.tsx");
      return has(text, /toSdkEventView\(/) && !has(text, /traceHref:\s*null/);
    },
  },
  lastProjectWritten: {
    item: 13,
    claim: "Serving a project page writes the last-project cookie.",
    fact: (tree) =>
      has(tree.read("lib/scope/proxy-handler.ts"), /(?<!function )\blastProjectCookie\(/),
  },
  projectPagesWithoutDatabase: {
    item: 20,
    claim: "The project layout returns its page when no database is configured.",
    fact: (tree) =>
      has(
        tree.read("app/(app)/project/[projectId]/layout.tsx"),
        /if \(!isDbConfigured\(\)\) return children/,
      ),
  },
  ingestAddressBuilders: {
    item: 21,
    claim: "Project home and onboarding build the ingest address with the same function.",
    fact: (tree) => {
      const text =
        tree.read("components/home/v2/OverviewPage.tsx") + tree.read("app/onboarding/page.tsx");
      const builders = new Set(
        [...text.matchAll(/\b(\w+)\(\s*"\/(?:v1\/)?traces"\s*\)/g)].map((match) => match[1]),
      );
      return builders.size;
    },
  },
  adoptionReadApart: {
    item: 23,
    claim: "The override-adoption read has its own fallback, apart from the rewrites read.",
    fact: (tree) => adoptionReadApart(tree.read("lib/fixes/load.ts")),
  },
  routesUseProjectScope: {
    item: 24,
    claim:
      "The playground rank route and the trace summary route resolve the project through findProjectScope.",
    fact: (tree) =>
      [
        "app/api/playground/rank/route.ts",
        "app/api/projects/[projectId]/traces/[traceId]/summary/route.ts",
      ].every((path) => has(tree.read(path), /\bfindProjectScope\(/)),
  },
  rootMetadata: {
    item: 25,
    claim: "Root metadata sets a title template, a description and an icon.",
    fact: (tree) => {
      const text = tree.read("app/layout.tsx");
      const template = text.match(/template:\s*[`"']([^`"']*)[`"']/)?.[1] ?? null;
      return [
        `template=${template}`,
        `description=${has(text, /\bdescription:/)}`,
        `icon=${has(text, /\bicons:/)}`,
      ];
    },
  },
  jobsInProjectLogContext: {
    item: 27,
    claim: "The job kinds whose handler runs in the project log context.",
    fact: (tree) => wrappedJobKinds(tree.read("lib/jobs/handlers.ts")),
  },
  playgroundHeading: {
    item: 28,
    claim: "The playground page's heading.",
    fact: (tree) =>
      tree
        .read("components/playground/PlaygroundWorkbench.tsx")
        .match(/<h1[^>]*>\s*([^<{]+?)\s*<\/h1>/)?.[1] ?? null,
  },
} as const satisfies Record<string, SourceProbe>;

export type SourceProbeId = keyof typeof SOURCE_PROBES;

/** Which of these functions the drain's source calls (item 2 reads the retention ones). */
export function calledBy(text: string, names: readonly string[]): string[] {
  return names.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
}

export function sourceFacts(tree: SourceTree): Record<SourceProbeId, Fact> {
  const out = {} as Record<SourceProbeId, Fact>;
  for (const id of Object.keys(SOURCE_PROBES) as SourceProbeId[])
    out[id] = SOURCE_PROBES[id].fact(tree);
  return out;
}
