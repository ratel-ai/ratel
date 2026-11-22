import { cn } from "@ratel/design-system/cn";
import { CornerDownRight } from "lucide-react";
import {
  MCP_CAPABILITY_GROUPS,
  MCP_EXAMPLE_CONCLUSION,
  MCP_EXAMPLE_QUESTION,
  MCP_EXAMPLE_STEPS,
} from "@/lib/mcp/connect/snippets";

/**
 * A session, drawn as a record and not as a snippet: there is nothing here
 * to copy. The question, each tool call, what came back, and what it means.
 */
export function McpExample() {
  return (
    <figure className="flex flex-col gap-4 rounded-lg border border-line bg-raised p-4">
      <p className="text-sm font-medium text-fg">&ldquo;{MCP_EXAMPLE_QUESTION}&rdquo;</p>
      {MCP_EXAMPLE_STEPS.map((step) => (
        <div key={step.tool} className="flex flex-col gap-2">
          <p className="flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
            <CornerDownRight aria-hidden strokeWidth={1.5} className="size-3.5 shrink-0" />
            <code
              translate="no"
              className="rounded border border-line bg-app px-1.5 py-0.5 font-mono text-xs text-fg"
            >
              {step.tool}
            </code>
            {step.args ? (
              <code translate="no" className="font-mono text-xs text-fg-muted">
                {step.args}
              </code>
            ) : null}
          </p>
          <table className="ml-5 w-[calc(100%-1.25rem)] border-separate border-spacing-0 text-ui">
            {step.columns ? (
              <thead>
                <tr>
                  {step.columns.map((column, index) => (
                    <th
                      key={column}
                      scope="col"
                      className={cn(
                        "h-8 border-b border-line px-3 text-xs font-medium text-fg-subtle",
                        index === 0 ? "text-left" : "text-right",
                      )}
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {step.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td
                      key={index}
                      className={cn(
                        "h-8 border-b border-line px-3 font-mono text-xs",
                        index === 0 ? "text-left text-fg" : "text-right text-fg-muted tabular-nums",
                      )}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <figcaption className="text-ui text-fg-muted">{MCP_EXAMPLE_CONCLUSION}</figcaption>
    </figure>
  );
}

/** The tool groups the server exposes, each with a few real tool names. */
export function McpCapabilities() {
  return (
    <ul className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
      {MCP_CAPABILITY_GROUPS.map((group) => (
        <li key={group.title} className="flex flex-col gap-2 bg-app p-4">
          <div>
            <p className="text-ui font-medium text-fg">{group.title}</p>
            <p className="text-xs text-fg-subtle">{group.blurb}</p>
          </div>
          <ul className="flex flex-wrap gap-1">
            {group.examples.map((example) => (
              <li key={example}>
                <code
                  translate="no"
                  className="rounded border border-line px-1.5 py-0.5 font-mono text-xs text-fg-muted"
                >
                  {example}
                </code>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
