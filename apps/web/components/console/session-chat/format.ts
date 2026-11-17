import { formatStepTime, type TrackSegment } from "@/lib/views/session-chat/model";

/** HH:MM in UTC, the same on the server and in the browser. */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** What a step did, in words: "Thinking", "Searched for a tool", "Called get_seat_map". */
export function stepWords(segment: TrackSegment): string {
  switch (segment.kind) {
    case "model_call":
      return `Thinking (${segment.label})`;
    case "search":
      return "Searched for a tool";
    case "tool_call":
      return `Called ${segment.label}`;
    case "ask":
      return "Their message";
    case "wait":
      return `Waited, ${segment.label}`;
  }
}

/** A step's measured time, or that it was not measured. */
export function segmentTime(segment: TrackSegment): string {
  return segment.measured && segment.realMs !== null
    ? formatStepTime(segment.realMs)
    : "time not measured";
}
