import type { TurnConversation as Conversation } from "@/lib/views/traces/sentiment/example";

/**
 * The words around a turn as a chat, in the order they happened: the user's
 * message sits above the calls (`TurnAsked`; the model calls' ask when no
 * message of theirs was read), the agent's reply and what came after below
 * them (`TurnAfter`): the user's next message, or, when no messages are sent,
 * the agent's next reply, which is how a reaction shows. The user's messages
 * sit on the right, the agent's on the left. Read when the page is opened,
 * never stored. Behind `cloud-sentiment-analysis`.
 */
export function TurnAsked({
  conversation,
  fallback,
}: {
  conversation: Conversation /** The ask the model calls carry, when no message of the user's was read. */;
  fallback: string | null;
}) {
  const asked = conversation.request ?? fallback;
  if (!asked) return null;
  return (
    <section aria-label="Asked" data-turn-asked="">
      <Message speaker="user" text={asked} />
    </section>
  );
}

export function TurnAfter({ conversation }: { conversation: Conversation }) {
  const { reply, next } = conversation;
  if (!reply && !next) return null;
  return (
    <section aria-label="What came after" data-turn-conversation="" className="flex flex-col gap-3">
      {reply ? <Message speaker="agent" text={reply} /> : null}
      {next ? (
        <Message
          speaker={next.from === "person" ? "user" : "agent"}
          tag="Next message"
          note={
            next.from === "agent"
              ? "No message from the user was sent: this is how the agent answered what came next."
              : undefined
          }
          text={next.text}
          emphasis
        />
      ) : null}
    </section>
  );
}

/** One message of the conversation, as a chat shows it: the user's on the right, the agent's on the left. */
function Message({
  speaker,
  text,
  tag,
  note,
  emphasis = false,
}: {
  speaker: "user" | "agent";
  text: string;
  tag?: string;
  note?: string;
  emphasis?: boolean;
}) {
  const user = speaker === "user";
  return (
    <div
      className={`flex min-w-0 ${user ? "justify-end" : "justify-start"}`}
      data-turn-message={speaker}
    >
      <div
        className={`max-w-[85%] min-w-0 rounded-2xl border px-4 py-3 ${user ? "rounded-br-md" : "rounded-bl-md"} ${
          emphasis
            ? "border-coral/40 bg-coral/5"
            : user
              ? "border-forest-300 bg-forest-300/25"
              : "border-forest-300 bg-forest-600/40"
        }`}
      >
        <p className="eyebrow">
          {user ? "User" : "Agent"}
          {tag ? <span className="ml-2 font-normal normal-case text-warm-muted">{tag}</span> : null}
        </p>
        <p className="mt-1 text-sm leading-6 whitespace-pre-line text-cream [overflow-wrap:anywhere]">
          {text}
        </p>
        {note ? <p className="mt-1 text-[12px] text-warm-muted">{note}</p> : null}
      </div>
    </div>
  );
}
