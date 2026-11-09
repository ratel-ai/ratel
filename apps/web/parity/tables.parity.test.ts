import { newProjectHref, organizationRoot } from "@/lib/console/navigation";
import { isImportedSourceId } from "@/lib/ledger/constants";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { resolveSelfTelemetryConfig } from "@/lib/platform/otel/config";
import { ORGANIZATION_SLUG, SOURCE_IDS, TELEMETRY_ENVIRONMENTS } from "./inputs";
import { control, parity } from "./ledger";
import { telemetryConfig } from "./normalise";
import { golden, plain, same } from "./support";

// Items 10, 14 and 17, and the self-telemetry configuration: small tables of answers.

parity(17, "a source id counts as an Agent health import exactly when Cloud says so", () => {
  same(
    SOURCE_IDS.map((id) => ({ id, imported: isImportedSourceId(id) })),
    golden("imported-source"),
  );
});

parity(
  10,
  "the migrations leave Cloud's storage options on the three OpenTelemetry tables",
  async () => {
    const client = await createMigratedPGlite();
    try {
      const result = await client.query<{ relname: string; reloptions: string[] | null }>(
        "select relname, reloptions from pg_class where relkind = 'r' and relname in ('otel_spans', 'otel_logs', 'otel_trace_summaries') order by relname",
      );
      same(
        {
          tableOptions: Object.fromEntries(
            result.rows.map((row) => [row.relname, [...(row.reloptions ?? [])].sort()]),
          ),
        },
        golden("schema-facts"),
      );
    } finally {
      await client.close();
    }
  },
);

parity(14, '"New project" sends a person where Cloud sends them', () => {
  const href = newProjectHref(organizationRoot(ORGANIZATION_SLUG));
  same(
    { destinationPath: new URL(href, "https://console.example").pathname },
    golden("new-project"),
  );
});

control("the self-telemetry configuration resolves as Cloud's does", () => {
  const cloud = golden<{ name: string; config: unknown }[]>("self-telemetry");
  const here = TELEMETRY_ENVIRONMENTS.map(({ name, deploymentEnvironment, env }) => ({
    name,
    config: resolveSelfTelemetryConfig(env, { deploymentEnvironment }),
  }));
  const normalised = (list: { name: string; config: unknown }[]) =>
    list.map(({ name, config }) => ({ name, config: telemetryConfig(config) }));
  same(normalised(plain(here) as typeof here), normalised(cloud));
});
