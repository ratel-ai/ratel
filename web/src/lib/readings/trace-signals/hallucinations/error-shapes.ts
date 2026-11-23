import type { HallucinationEvidence } from "@/lib/readings/trace-signals/hallucinations/kinds";
import { messageOf } from "@/lib/readings/trace-signals/outcomes/error-cause";

/**
 * What a failed call's error says the agent made up. Pure, and narrow on
 * purpose: a finding should be right when it fires, so a message that could
 * be about access, a limit or the tool itself reads as nothing here (it stays
 * a root cause). Read from the words as sent, in memory; only the shape's id
 * is kept.
 *
 *   unknown_tool        the error names a tool that does not exist;
 *   unknown_reference   "<record> not found" or "no <record> matched", with no
 *                       hint that access is why;
 *   value_not_allowed   the error lists the values it does take.
 */

export type ErrorShape = "unknown_tool" | "unknown_reference" | "value_not_allowed";

export interface ErrorShapeReading {
  shape: ErrorShape;
  evidence: HallucinationEvidence;
}

const MAX_CHARS = 2_000;

const NAMES_TOOL =
  /\b(?:unknown|invalid|unrecogni[sz]ed) (?:tool|function)\b|\bno such (?:tool|function)\b|\b(?:tool|function)\b[^.\n]{0,80}\b(?:not found|does not exist|doesn'?t exist|is not (?:available|registered|defined))\b|\b(?:tool|function)[ _]not[ _]found\b/i;

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

const firstSentence = (text: string): string => {
  const cut = text.search(/[.!?](?=\s)|\n|\s[—–-]\s/);
  return (cut < 0 ? text : text.slice(0, cut)).trim();
};

/** The shape of one error message; null when it says nothing a rule can stand on. */
export function errorShapeOf(raw: string | null | undefined): ErrorShapeReading | null {
  if (!raw || raw.trim() === "") return null;
  const text = messageOf(raw).slice(0, MAX_CHARS);
  if (NAMES_TOOL.test(text)) return { shape: "unknown_tool", evidence: "error_names_tool" };
  if (LISTS_VALUES.test(text))
    return { shape: "value_not_allowed", evidence: "lists_allowed_values" };
  if (ACCESS_HEDGE.test(text)) return null;
  const first = firstSentence(text);
  if (NO_MATCH.test(first)) return { shape: "unknown_reference", evidence: "no_entity_matched" };
  if (NOT_FOUND.test(first)) return { shape: "unknown_reference", evidence: "entity_not_found" };
  return null;
}
