import type { TraceViewProps } from "@/lib/views/traces/trace-view-types";

/**
 * Span attributes that name things rather than carry the customer's text: the
 * model and tool, the operation, token counts and the error type. A caller who
 * may not read captured text (lib/mcp/operations/content-access.ts) gets these
 * and nothing else of a span's attributes.
 */
const NAMING_ATTRIBUTE =
  /^(gen_ai\.(tool\.name|request\.model|response\.model|operation\.name|system|provider\.name|usage\.[a-z_.]+)|error\.type|service\.name)$/;

/**
 * The props without captured text, as get_trace serves them to a caller
 * without content access: no messages, prompts, tool payloads, search queries,
 * payload content or experiment attributes; the title is the root step's own
 * (`title`), not the ask. Names, timing, tokens, cost and status stay.
 */
export function withoutCapturedText(props: TraceViewProps, title: string): TraceViewProps {
  return {
    ...props,
    title,
    payloadContent: null,
    waterfall: {
      ...props.waterfall,
      rows: props.waterfall.rows.map((row) => ({
        ...row,
        span: {
          ...row.span,
          searchQuery: null,
          experimentAttrs: {},
          attributes: Object.fromEntries(
            Object.entries((row.span.attributes ?? {}) as Record<string, unknown>).filter(([key]) =>
              NAMING_ATTRIBUTE.test(key),
            ),
          ),
        },
      })),
    },
    lifecycle: props.lifecycle.map((record) => ({ ...record, experimentAttrs: {} })),
  };
}
