import { type ServerEventContext, trackServerEvent } from "@/lib/platform/telemetry";
import type { DatasetLifecycleEvent } from "./export-api";
import type { OverrideEvent } from "./review-api";

/** `dataset_row_excluded` or `dataset_row_pinned`: ids and the new value, never row text. */
export function trackOverrideEvent(
  event: OverrideEvent,
  context: ServerEventContext,
  surface: "console" | "mcp",
): Promise<void> {
  return trackServerEvent(event.name, context, {
    object_action: event.name,
    use_case_id: event.useCaseId,
    turn_id: event.turnId,
    value: event.value,
    surface,
  });
}

/** `dataset_exported` or `dataset_deleted` (RC-1131): ids, version and counts, never row text. */
export function trackDatasetLifecycleEvent(
  event: DatasetLifecycleEvent,
  context: ServerEventContext,
  surface: "console" | "mcp",
): Promise<void> {
  return trackServerEvent(event.name, context, {
    object_action: event.name,
    dataset_id: event.dataset.id,
    use_case_id: event.dataset.useCaseId,
    version: event.dataset.version,
    ...(event.name === "dataset_exported"
      ? { side: event.side, rows: event.rows, skipped: event.skipped }
      : {}),
    surface,
  });
}
