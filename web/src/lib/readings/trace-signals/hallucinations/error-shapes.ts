import type { HallucinationEvidence } from "@/lib/readings/trace-signals/hallucinations/kinds";
import { messageOf } from "@/lib/readings/trace-signals/outcomes/error-cause";

/**
 * What a failed call's error says the agent made up. Pure, and narrow on
 * purpose: a finding should be right when it fires, so a message that could
 * be about access, a limit, the setup (a missing key, config or file), a bare
 * HTTP status or the tool itself reads as nothing here (it stays a root
 * cause). Read from the words as sent, in memory; only the shape's id is kept.
 *
 *   unknown_tool        the error names a tool that does not exist;
 *   unknown_reference   "<record> not found" or "no <record> matched", with no
 *                       hint that access is why;
 *   value_not_allowed   the error lists the values it does take.
 */

type ErrorShape = "unknown_tool" | "unknown_reference" | "value_not_allowed";

interface ErrorShapeReading {
  shape: ErrorShape;
  evidence: HallucinationEvidence;
}

const MAX_CHARS = 2_000;

/**
 * The error names a tool as missing: "unknown tool", "no such function",
 * "tool_not_found", or a sentence that opens with the tool and says it is
 * missing. A tool word somewhere near "not found" is not enough: runtimes
 * name the tool that ran when they pass on its own error.
 */
const NAMES_TOOL =
  /\b(?:unknown|invalid|unrecogni[sz]ed) (?:tool|function)\b|\bno such (?:tool|function)\b|\b(?:tool|function)[ _]not[ _]found\b|^(?:the )?(?:tool|function) [`'"]?[\w.:/-]+[`'"]? (?:was |is )?(?:not found|does not exist|doesn'?t exist|not (?:available|registered|defined)|is not (?:available|registered|defined))\b/i;

/** A runtime's wrapper around the tool's own error: "Error executing tool get_issue: …", "Tool execution failed: …". */
const WRAPPER =
  /^(?:error (?:executing|calling|running|invoking) (?:tool|function)(?: [`'"]?[\w.:/-]+[`'"]?)?|(?:tool|function)(?: [`'"]?[\w.:/-]+[`'"]?)? (?:execution |call )?(?:failed|error)(?: for [`'"]?[\w.:/-]+[`'"]?)?)\s*[:—–-]\s*/i;

/** "Not found" that may be about access: a missing record and a hidden one are reported the same way. */
const ACCESS_HEDGE =
  /\bnot accessible\b|\b(?:no|have|has|without|lack(?:s|ing)?) access\b|\bpermissions?\b|\bnot (?:authori[sz]ed|allowed|permitted)\b|\bforbidden\b|\bdenied\b|\bprivate\b|\bnot (?:signed|logged) in\b|\bconnect your\b/i;

/** "<record> not found", read on the first sentence: at most a few words name the record. */
const NOT_FOUND =
  /^(?:the |that |this |requested |specified |given )*(?:[\w#-]+ ){0,4}?[\w#-]+ (?:was |were |is |could (?:not|n'?t) be )?(?:not found|does not exist|doesn'?t exist|do not exist)\b/i;
const NO_MATCH =
  /^no (?:[\w#-]+ ){0,4}?[\w#-]+ (?:matched|matches|matching|found|exists?|with (?:that|this|the given))\b/i;

const LISTS_VALUES =
  /\b(?:available|allowed|valid|supported|permitted|accepted)(?: (?:values?|options?|choices|statuses|types|keys))?(?: are| is)?:\s*\S|\bmust be one of\b|\bexpected one of\b|\bone of the following\b|\bis not a valid (?:\w+ )?(?:value|option|status|type|choice)\b|\binvalid enum\b/i;

/** JSON-RPC's unknown method (-32601): the agent called something the server does not have. */
const UNKNOWN_METHOD = /\bmethod not found\b/i;

/** A limit or quota: "allowed: 100 requests" is the limit, not the values a field takes. */
const LIMIT =
  /\brate[ -]?limit|\bquota\b|\btoo many requests\b|\bthrottl|\blimit (?:exceeded|reached)\b/i;

/** The setup is missing, not a record the agent named: a key, token, credential, config or file. */
const SETUP =
  /\b(?:api[ _-]?keys?|keys?|tokens?|credentials?|secrets?|passwords?|config(?:uration)?|settings|env(?:ironment)?(?: var(?:iable)?s?)?|certificates?|files?)\b/i;

/** A bare HTTP status line: "404 Not Found", "HTTP 404: Not Found", "Not Found". */
const STATUS_LINE = /^(?:http(?:\/[\d.]+)?\s*)?(?:\d{3}\s*[:—–-]?\s*)?not found\.?$/i;

const firstSentence = (text: string): string => {
  const cut = text.search(/[.!?](?=\s)|\n|\s[—–-]\s/);
  return (cut < 0 ? text : text.slice(0, cut)).trim();
};

/** The shape of one error message; null when it says nothing a rule can stand on. */
export function errorShapeOf(raw: string | null | undefined): ErrorShapeReading | null {
  if (!raw || raw.trim() === "") return null;
  const text = messageOf(raw).slice(0, MAX_CHARS).replace(WRAPPER, "");
  if (NAMES_TOOL.test(text) || UNKNOWN_METHOD.test(text))
    return { shape: "unknown_tool", evidence: "error_names_tool" };
  if (!LIMIT.test(text) && LISTS_VALUES.test(text))
    return { shape: "value_not_allowed", evidence: "lists_allowed_values" };
  if (ACCESS_HEDGE.test(text) || STATUS_LINE.test(text.trim())) return null;
  const first = firstSentence(text);
  if (SETUP.test(first)) return null;
  if (NO_MATCH.test(first)) return { shape: "unknown_reference", evidence: "no_entity_matched" };
  if (NOT_FOUND.test(first)) return { shape: "unknown_reference", evidence: "entity_not_found" };
  return null;
}
