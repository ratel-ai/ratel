"use client";

import { Badge } from "@ratel/design-system/badge";
import { CodeBlock } from "@ratel/design-system/code";
import { type Column, DataTable } from "@ratel/design-system/data-table";
import { Disclosure } from "@ratel/design-system/disclosure";
import { Section } from "@ratel/design-system/section";
import type { ReactNode } from "react";
import type { McpFactRow, McpServerGuide } from "@/lib/views/mcp-servers/setup-guide";

/**
 * Instrument an MCP server with standard OpenTelemetry (RC-780): the exporter
 * env, a Python and a TypeScript server, the facts each attribute gives, the
 * limits of the standard path and how to send no client IP. Open on an empty
 * list; behind a Disclosure once data arrives.
 */
export function McpServerSetupGuide({
  guide,
  defaultOpen = false,
}: {
  guide: McpServerGuide;
  defaultOpen?: boolean;
}) {
  return (
    <Section
      className="max-w-4xl"
      title="Instrument your MCP server"
      description="Standard OpenTelemetry is enough: no Ratel SDK. Set service.name, trace each MCP request, and trace the HTTP server in the same trace."
    >
      <Disclosure
        title="Setup guide"
        hint="Python and TypeScript, the facts each attribute gives, limits"
        defaultOpen={defaultOpen}
      >
        <div className="flex flex-col gap-5 pt-3">
          <Step title="1. Point the exporter at Ratel">
            <CodeBlock caption="Shell" samples={[{ label: "Shell", code: guide.env }]} />
          </Step>
          <Step title="2. Trace the server">
            <CodeBlock
              samples={guide.snippets.map((snippet) => {
                const comment = snippet.lang === "python" ? "#" : "//";
                return {
                  label: snippet.label,
                  code: [
                    `${comment} ${snippet.install}`,
                    ...snippet.files.map((file) => `${comment} ${file.name}\n${file.code}`),
                    `${comment} Run: ${snippet.run}`,
                  ].join("\n\n"),
                };
              })}
            />
          </Step>
          <Step title="What each attribute gives">
            <DataTable
              caption="Facts"
              columns={FACT_COLUMNS}
              rows={guide.facts}
              rowKey={(row) => row.fact}
              density="compact"
            />
          </Step>
          <Step title="Limits">
            <ul className="flex list-disc flex-col gap-1 pl-5 text-ui text-fg-muted">
              {guide.limits.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Step>
          <Step title="Send no client IP">
            <p className="text-ui text-fg-muted">{guide.noClientIp.text}</p>
            <CodeBlock
              samples={[
                { label: "Python", code: guide.noClientIp.python },
                { label: "Collector", code: guide.noClientIp.collector },
              ]}
            />
          </Step>
          <Step title="When to add the Ratel SDK">
            <p className="text-ui text-fg-muted">{guide.whenSdk}</p>
          </Step>
        </div>
      </Disclosure>
    </Section>
  );
}

const FACT_COLUMNS: Column<McpFactRow>[] = [
  {
    id: "fact",
    header: "Fact",
    width: "11rem",
    cell: (row) => <span className="text-fg">{row.fact}</span>,
  },
  {
    id: "attributes",
    header: "Attribute",
    cell: (row) => <span className="font-mono text-xs text-fg">{row.attributes.join(", ")}</span>,
  },
  {
    id: "on",
    header: "On",
    hiddenBelow: "md",
    cell: (row) => <span className="text-fg-muted">{row.on}</span>,
  },
  {
    id: "source",
    header: "Source",
    width: "8rem",
    cell: (row) =>
      row.source === "sdk" ? <Badge tone="info">Ratel SDK</Badge> : <Badge>Standard</Badge>,
  },
];

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-fg">{title}</p>
      {children}
    </div>
  );
}
