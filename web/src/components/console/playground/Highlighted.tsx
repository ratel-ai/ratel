import { highlight } from "@/lib/synthesis/playground/matched-words";

/** Text with the ask's words lit, so "why did this match" is visible without asking. */
export function Highlighted({ text, terms }: { text: string; terms: ReadonlySet<string> }) {
  return (
    <>
      {highlight(text, terms).map((segment, index) =>
        segment.match ? (
          <mark key={index} className="rounded-[3px] bg-info-subtle px-px text-fg">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
