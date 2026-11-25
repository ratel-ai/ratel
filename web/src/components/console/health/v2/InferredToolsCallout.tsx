import { Callout } from "@ratel/design-system/states";
import { ArrowUpRight } from "lucide-react";
import { IMPORT_CAPTURE_GUIDE_URL } from "@/components/console/health/v2/PartialReading";

/**
 * The reading's tool calls were read from the shape of imported spans (the
 * steps that run inside no other step), not from tool calls the source
 * recorded, and no message content came with them. Says what we received and what is missing, once, near the top.
 */

export const INFERRED_TOOLS_TITLE = "Tool calls inferred from span shape · content not captured";

export function InferredToolsCallout() {
  return (
    <div data-health-inferred-tools="">
      <Callout
        title={INFERRED_TOOLS_TITLE}
        action={
          <a
            href={IMPORT_CAPTURE_GUIDE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-fg underline-offset-4 hover:underline"
          >
            How to send tool calls
            <ArrowUpRight className="size-3.5" aria-hidden />
          </a>
        }
      >
        Received: the steps of each run, with their timing, errors, models and tokens. Each step
        that runs inside no other step is read as a tool call. Missing: what people asked, the
        replies and the tool arguments and results, so issues that need them are not found.
      </Callout>
    </div>
  );
}
