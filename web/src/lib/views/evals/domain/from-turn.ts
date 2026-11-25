import type { TraceMessageView, TraceToolCallView } from "@/lib/synthesis/traces/content-view";
import { conversationMessages } from "@/lib/synthesis/traces/v2/conversation";
import type { CaseContent, EarlierTurn } from "./case";

/** What one turn recorded, as the traces pages read it. */
export type TurnContent = {
  ask: string | null;
  messages: readonly TraceMessageView[];
  toolCalls: readonly TraceToolCallView[];
};

export type CaseFromTurn = { name: string; content: CaseContent; sourceOutput: string | null };

const NAME_CHARS = 80;

/**
 * A case from a turn. `readOnlyTools` are the tools that run for real in a sandbox, so they need
 * no fixture. A tool that no sandbox declares counts as one with side effects. Null: the turn has
 * no captured input.
 */
export function caseFromTurn(
  turn: TurnContent,
  readOnlyTools: ReadonlySet<string>,
): CaseFromTurn | null {
  const messages = conversationMessages(turn.messages);
  const own = messages.filter((message) => !message.earlier);
  const asked = own
    .filter(({ role }) => role === "user")
    .map(({ text }) => text)
    .join("\n\n");
  const text = asked || turn.ask;
  if (!text) return null;
  return {
    name: nameOf(text),
    content: {
      input: inputOf(text),
      earlierTurns: messages.flatMap(earlierTurn),
      toolFixtures: turn.toolCalls
        .filter((call) => !call.earlier && call.result !== null && !readOnlyTools.has(call.name))
        .map((call) => ({
          tool: call.name,
          arguments: call.arguments ?? null,
          result: call.result ?? null,
        })),
      expectedOutput: null,
      scorers: [],
    },
    sourceOutput: own.findLast(({ role }) => role === "assistant")?.text ?? null,
  };
}

function earlierTurn({ role, text, earlier }: TraceMessageView): EarlierTurn[] {
  return earlier && (role === "user" || role === "assistant") ? [{ role, text }] : [];
}

/** The recorded JSON input of a sandbox run, else the person's message. */
function inputOf(text: string): object {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null) return value;
  } catch {
    // A message is text.
  }
  return { message: text };
}

function nameOf(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > NAME_CHARS ? `${line.slice(0, NAME_CHARS - 1)}…` : line;
}
