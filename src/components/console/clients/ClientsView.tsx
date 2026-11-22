"use client";

import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { Callout, EmptyState } from "@ratel/design-system/states";
import { Users } from "lucide-react";
import type { ReactNode } from "react";
import type { RangePreset } from "@/lib/synthesis/dashboard";
import { formatInteger, formatPercent, formatRelativeTime } from "@/lib/synthesis/traces/v2/format";
import type {
  ClientsOverview,
  CountryRow,
  HarnessRow,
  HarnessVersionRow,
  ValueCount,
} from "@/lib/views/clients/queries";
import { ClientsFilters } from "./ClientsFilters";
import { countryLabel, harnessLabel, reportedLabel, transportLabel } from "./labels";

/** Dates as ISO strings: what the page sends over the wire. */
type Serialized<T> = Omit<T, "firstSeenAt" | "lastSeenAt"> & {
  firstSeenAt: string;
  lastSeenAt: string;
};

export type ClientsHarnessItem = Serialized<HarnessRow>;
export type ClientsVersionItem = Serialized<HarnessVersionRow>;

export type ClientsOverviewView = Omit<
  ClientsOverview,
  "harnesses" | "versions" | "servers" | "environments"
> & {
  harnesses: ClientsHarnessItem[];
  versions: ClientsVersionItem[];
};

export interface ClientsFilterState {
  servers: readonly string[];
  server: string | null;
  environments: readonly string[];
  environment: string | null;
  range: { preset: RangePreset | "custom"; from: string; to: string };
}

/** Required by DB-IP's CC BY 4.0 licence wherever its country data shows. */
export const DB_IP_URL = "https://db-ip.com";
/** Where to wire an MCP server's spans, for calls that reported no client. */
export const CLIENT_SETUP_DOCS_URL = "https://docs.ratel.sh/observability";

type HarnessStats = Pick<HarnessRow, "calls" | "sessions" | "errorRate">;

const LINK =
  "rounded-md underline decoration-line-strong underline-offset-4 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus";

const COUNTRY_COLUMNS: Column<CountryRow>[] = [
  { id: "country", header: "Country", cell: (row) => countryLabel(row.country) },
  {
    id: "calls",
    header: "Calls",
    align: "right",
    width: "6rem",
    cell: (row) => formatInteger(row.calls),
  },
  {
    id: "sessions",
    header: "Sessions",
    align: "right",
    width: "6rem",
    cell: (row) => formatInteger(row.sessions),
  },
];

/**
 * The MCP page's Clients tab (RC-778): "Who calls my MCP servers?" The
 * harnesses and their versions, the callers' countries, the transports and
 * the protocol versions, read from the server's own spans. No IP address
 * shows here.
 */
export function ClientsView({
  overview,
  filters,
  tabs,
  now,
}: {
  /** Null when the read failed: unknown, not empty. */
  overview: ClientsOverviewView | null;
  filters: ClientsFilterState;
  tabs: ReactNode;
  now: string;
}) {
  return (
    <Page>
      <PageHeader title="MCP servers" actions={<ClientsFilters {...filters} />} tabs={tabs} />
      <PageBody wide>
        {overview === null ? (
          <Callout tone="danger" title="Clients could not be read">
            Reload the page. If it fails again, try a shorter window.
          </Callout>
        ) : overview.harnesses.length === 0 ? (
          <EmptyState
            icon={Users}
            title={emptyTitle(filters)}
            description="Clients show up here once your MCP servers send spans for their calls."
          />
        ) : (
          <ClientsSections overview={overview} now={now} />
        )}
      </PageBody>
    </Page>
  );
}

function ClientsSections({ overview, now }: { overview: ClientsOverviewView; now: string }) {
  const hasUnknown = overview.harnesses.some((row) => row.harness === null);
  return (
    <>
      <Section title="By client">
        <DataTable
          caption="Calls by client"
          columns={harnessColumns(now)}
          rows={overview.harnesses}
          rowKey={(row) => row.harness ?? "unknown"}
        />
        {hasUnknown ? <UnknownClientHint /> : null}
      </Section>

      {overview.versions.length > 0 ? (
        <Section title="By client version">
          <DataTable
            caption="Calls by client version"
            columns={versionColumns(now)}
            rows={overview.versions}
            rowKey={(row) => `${row.harness ?? "unknown"}:${row.version ?? ""}`}
          />
        </Section>
      ) : null}

      <Section title="By country">
        <DataTable
          caption="Calls by country"
          columns={COUNTRY_COLUMNS}
          rows={overview.countries}
          rowKey={(row) => row.country ?? "unknown"}
        />
        <p className="text-xs text-fg-subtle">
          <a href={DB_IP_URL} target="_blank" rel="noreferrer" className={LINK}>
            IP Geolocation by DB-IP
          </a>
        </p>
      </Section>

      <div className="grid gap-8 lg:grid-cols-2">
        <Section title="Transport">
          <ValueTable
            caption="Calls by transport"
            rows={overview.transports}
            format={transportLabel}
          />
        </Section>
        <Section title="Protocol version">
          <ValueTable
            caption="Calls by protocol version"
            rows={overview.protocolVersions}
            format={reportedLabel}
          />
        </Section>
      </div>
    </>
  );
}

function UnknownClientHint() {
  return (
    <p className="text-ui text-fg-muted">
      Unknown client: a stdio MCP server reports no client on the standard OpenTelemetry path. An
      HTTP server reports the caller from its HTTP server span.{" "}
      <a href={CLIENT_SETUP_DOCS_URL} target="_blank" rel="noreferrer" className={LINK}>
        Setup guide
      </a>
    </p>
  );
}

/** A value's share of the calls: the two split tables read as parts of one whole. */
function ValueTable({
  caption,
  rows,
  format,
}: {
  caption: string;
  rows: readonly ValueCount[];
  format: (value: string | null) => string;
}) {
  const total = rows.reduce((sum, row) => sum + row.calls, 0);
  const columns: Column<ValueCount>[] = [
    { id: "value", header: "Value", cell: (row) => format(row.value) },
    {
      id: "calls",
      header: "Calls",
      align: "right",
      width: "6rem",
      cell: (row) => formatInteger(row.calls),
    },
    {
      id: "share",
      header: "Share",
      align: "right",
      width: "6rem",
      cell: (row) => formatPercent(total > 0 ? row.calls / total : null),
    },
  ];
  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.value ?? "none"}
      density="compact"
    />
  );
}

function harnessColumns(now: string): Column<ClientsHarnessItem>[] {
  return [
    { id: "client", header: "Client", cell: (row) => <ClientName harness={row.harness} /> },
    ...statColumns<ClientsHarnessItem>(),
    {
      id: "first",
      header: "First seen",
      align: "right",
      width: "8rem",
      hiddenBelow: "lg",
      cell: (row) => formatRelativeTime(row.firstSeenAt, now),
    },
    {
      id: "last",
      header: "Last seen",
      align: "right",
      width: "8rem",
      hiddenBelow: "md",
      cell: (row) => formatRelativeTime(row.lastSeenAt, now),
    },
  ];
}

function versionColumns(now: string): Column<ClientsVersionItem>[] {
  return [
    { id: "client", header: "Client", cell: (row) => <ClientName harness={row.harness} /> },
    {
      id: "version",
      header: "Version",
      width: "10rem",
      cell: (row) => <span className="tabular-nums">{reportedLabel(row.version)}</span>,
    },
    ...statColumns<ClientsVersionItem>(),
    {
      id: "first",
      header: "First seen",
      align: "right",
      width: "8rem",
      hiddenBelow: "md",
      cell: (row) => formatRelativeTime(row.firstSeenAt, now),
    },
  ];
}

function statColumns<T extends HarnessStats>(): Column<T>[] {
  return [
    {
      id: "calls",
      header: "Calls",
      align: "right",
      width: "6rem",
      cell: (row) => formatInteger(row.calls),
    },
    {
      id: "sessions",
      header: "Sessions",
      align: "right",
      width: "6rem",
      hiddenBelow: "sm",
      cell: (row) => formatInteger(row.sessions),
    },
    {
      id: "errors",
      header: "Error rate",
      align: "right",
      width: "7rem",
      cell: (row) => formatPercent(row.errorRate),
    },
  ];
}

function ClientName({ harness }: { harness: string | null }) {
  return (
    <span className={harness === null ? "text-fg-muted" : "font-medium text-fg"}>
      {harnessLabel(harness)}
    </span>
  );
}

function emptyTitle(filters: ClientsFilterState): string {
  if (filters.server) return "No calls to this server in this window";
  if (filters.environment) return "No MCP calls in this environment";
  return "No MCP calls in this window";
}
