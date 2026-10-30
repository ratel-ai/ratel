import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyReply,
  PHRASE_CATEGORIES,
  type PhraseMatch,
} from "@/lib/readings/trace-signals/self-corrections/phrases";

/** `category:phrase` per match, in text order. */
const found = (text: string): string[] =>
  classifyReply(text).map((m) => `${m.category}:${m.phrase}`);

/** The text each match covers. */
const covered = (text: string, matches: readonly PhraseMatch[]): string[] =>
  matches.map((m) => text.slice(m.start, m.end));

// --- every phrase, where it should match ---------------------------------------

const POSITIVES: readonly [string, string][] = [
  ["I'm sorry, I used the wrong project id.", "apology:I'm sorry"],
  ["I’m sorry for the confusion.", "apology:I'm sorry"],
  ["I am sorry about the earlier answer.", "apology:I'm sorry"],
  ["I apologize for the confusion.", "apology:I apologize"],
  ["I apologise for the delay.", "apology:I apologize"],
  ["Sorry about that! The field is due_date.", "apology:Sorry about that"],
  ["My apologies, the limit is 50.", "apology:My apologies"],
  ["You're absolutely right, the API paginates.", "concession:You're absolutely right"],
  ["You are right that the limit is 50.", "concession:You're right"],
  ["You’re right about the timezone.", "concession:You're right"],
  ["Good catch! I will fix the query.", "concession:Good catch"],
  ["You're right to point that out: I used the old schema.", "concession:You're right"],
  ["Let me try that again with the correct id.", "retry:Let me try that again"],
  ["That failed. Let me try again.", "retry:Let me try again"],
  ["Let me retry the request.", "retry:Let me retry"],
  ["The call timed out. Trying again with a smaller page.", "retry:Trying again"],
  ["Let me try a different approach.", "retry:Let me try a different approach"],
  ["I made a mistake in the date range.", "admission:I made a mistake"],
  ["My mistake: the board is called Roadmap.", "admission:My mistake"],
  ["I was wrong about the default.", "admission:I was wrong"],
  ["I misread your request.", "admission:I misread"],
  ["That was incorrect. The right value is 12.", "admission:That was incorrect"],
  ["Actually, the API returns 3 rows.", "backtrack:Actually,"],
  ["The first call returned nothing. Actually, the API returns 3 rows.", "backtrack:Actually,"],
  ["On second thought, a webhook is simpler.", "backtrack:On second thought"],
  ["On second thoughts, keep the cron.", "backtrack:On second thought"],
  ["Wait, that list is from last week.", "backtrack:Wait,"],
  ["Correction: the meeting is on Tuesday.", "backtrack:Correction:"],
  ["Small correction: the meeting is on Tuesday.", "backtrack:Correction:"],
  ["Let me correct that: the total is 42.", "backtrack:Let me correct"],
  ["Let me correct myself.", "backtrack:Let me correct"],
  ["Let me correct the earlier answer.", "backtrack:Let me correct"],
  ["Let me correct.", "backtrack:Let me correct"],
];

for (const [text, expected] of POSITIVES) {
  test(`matches: ${text}`, () => {
    assert.deepEqual(found(text), [expected]);
  });
}

test("case does not matter, and a phrase may wrap a line", () => {
  assert.deepEqual(found("SORRY ABOUT THAT, the export is fixed."), ["apology:Sorry about that"]);
  assert.deepEqual(found("i'm sorry, wrong board."), ["apology:I'm sorry"]);
  assert.deepEqual(found("I'm\nsorry for the noise."), ["apology:I'm sorry"]);
});

// --- sentence-initial only ----------------------------------------------------

test("'Actually,' only opens a sentence, and only with its comma", () => {
  assert.deepEqual(found("The API actually returns 3 rows."), [], "mid-sentence, no comma");
  assert.deepEqual(
    found("Actually the API returns 3 rows."),
    [],
    "sentence-initial without the comma",
  );
  assert.deepEqual(found("The API returns, actually, 3 rows."), [], "a comma but mid-sentence");
  assert.deepEqual(found("The API is fine.  Actually, it returns 3 rows."), [
    "backtrack:Actually,",
  ]);
  assert.deepEqual(
    found("The plan is below\nActually, skip step two."),
    ["backtrack:Actually,"],
    "a new line opens a sentence",
  );
});

test("a sentence can open after a list marker, emphasis, a bracket or a closing quote", () => {
  assert.deepEqual(found("- Actually, the limit is 50."), ["backtrack:Actually,"]);
  assert.deepEqual(found("1. Actually, use the v2 endpoint."), ["backtrack:Actually,"]);
  assert.deepEqual(found("**Wait,** the id changed."), ["backtrack:Wait,"]);
  assert.deepEqual(found("(Actually, the docs are outdated.)"), ["backtrack:Actually,"]);
  assert.deepEqual(found('He said "stop." Actually, keep going.'), ["backtrack:Actually,"]);
});

test("'Wait,' only opens a sentence, and only with its comma", () => {
  assert.deepEqual(found("Please wait, the build is still running."), []);
  assert.deepEqual(found("Wait for the build to finish."), []);
  assert.deepEqual(
    found("Wait, wait, the id changed."),
    ["backtrack:Wait,"],
    "the second one is mid-sentence",
  );
});

test("'Correction:' opens a sentence or follows a small adjective, never a compound", () => {
  assert.deepEqual(found("Auto-correction: enabled."), []);
  assert.deepEqual(found("Error correction: on, parity: even."), []);
  assert.deepEqual(found("One quick correction: the date is Monday."), ["backtrack:Correction:"]);
});

// --- the same words, another meaning --------------------------------------------

test("'you're right to ask' validates the user; it concedes nothing", () => {
  assert.deepEqual(found("You're right to ask about rate limits."), []);
  assert.deepEqual(found("You're absolutely right to be careful here."), []);
  assert.deepEqual(found("You're right on track with the setup."), []);
  assert.deepEqual(found("You're right at the limit of the free plan."), []);
  assert.deepEqual(found("You're right-handed?"), []);
});

test("conditional or negated lead-ins are not admissions", () => {
  assert.deepEqual(found("If you're right, the export will fail."), []);
  assert.deepEqual(found("Let me know if I made a mistake."), []);
  assert.deepEqual(found("I don't think I was wrong here."), []);
  assert.deepEqual(found("It wasn't my mistake: the API changed."), []);
  assert.deepEqual(found("Not my mistake, the field was renamed."), []);
  assert.deepEqual(found("If trying again doesn't help, check the token."), []);
  assert.deepEqual(
    found("I'm not sure, but you're right."),
    ["concession:You're right"],
    "a lead-in earlier in the sentence does not count",
  );
});

test("sympathy and refusals are not apologies for a mistake", () => {
  assert.deepEqual(found("I'm sorry to hear the deploy failed."), []);
  assert.deepEqual(found("I'm sorry you're dealing with this outage."), []);
  assert.deepEqual(found("I'm sorry, but I can't access that workspace."), []);
  assert.deepEqual(found("I'm sorry, I cannot share credentials."), []);
  assert.deepEqual(found("I apologize, but I am unable to delete that project."), []);
  assert.deepEqual(
    found("I'm sorry, I used the staging id."),
    ["apology:I'm sorry"],
    "an apology that goes on to own the mistake",
  );
});

test("advice about trying again is not a retry", () => {
  assert.deepEqual(found("Trying again won't help until the quota resets."), []);
  assert.deepEqual(found("Trying again later should work."), []);
});

test("'let me correct' needs the agent's own words as its object", () => {
  assert.deepEqual(found("Let me correct the typo in your README."), []);
  assert.deepEqual(found("Let me correct your query: add a limit."), []);
});

test("'sorry' or 'catch' inside a longer word is not the phrase", () => {
  assert.deepEqual(found("Tagged it #sorryaboutthat in the tracker."), []);
  assert.deepEqual(found("lorrysorry about that shipment"), []);
  assert.deepEqual(found("Don't worry about that."), []);
  assert.deepEqual(found("Good catching up with you."), []);
  assert.deepEqual(found("My mistakes list is empty."), []);
});

// --- what is skipped ------------------------------------------------------------

test("a quoted user message is skipped, in straight or curly quotes", () => {
  assert.deepEqual(
    found(
      'You wrote: "I\'m sorry, but this is wrong. Actually, the date is Monday." I checked the calendar.',
    ),
    [],
  );
  assert.deepEqual(found("You said “You're right, my mistake” earlier."), []);
  assert.deepEqual(
    found("You said ‘You’re right, my mistake’ earlier."),
    [],
    "a curly apostrophe inside does not close the quote",
  );
  assert.deepEqual(
    found('You said:\n"Actually, the API\nreturns 3 rows"\nI will check.'),
    [],
    "a quote may wrap lines",
  );
  assert.deepEqual(
    found('Set the label to "Done". Sorry about that.'),
    ["apology:Sorry about that"],
    "text after the quote is read",
  );
});

test("an unclosed quote hides nothing", () => {
  assert.deepEqual(found('The screen is 5" wide. Sorry about that.'), ["apology:Sorry about that"]);
});

test("a quote does not reach across a blank line", () => {
  assert.deepEqual(found('He typed "hello\n\nSorry about that." to close it.'), [
    "apology:Sorry about that",
  ]);
});

test("block quotes are skipped, line by line", () => {
  assert.deepEqual(
    found("> I'm sorry, you're right.\n> Let me try again.\n\nHere is the summary."),
    [],
  );
  assert.deepEqual(
    found("> Is the budget 10k?\nActually, it is 12k."),
    ["backtrack:Actually,"],
    "an unmarked line after a quote is the reply",
  );
});

test("fenced code is skipped, closed or not", () => {
  const closed =
    '```js\nconsole.log("I\'m sorry");\n// Actually, retry\n```\nDone, sorry about that.';
  assert.deepEqual(found(closed), ["apology:Sorry about that"]);
  assert.deepEqual(found("~~~\nLet me try again\n~~~"), []);
  assert.deepEqual(
    found("Here:\n```\nsorry about that\n"),
    [],
    "an unclosed fence runs to the end",
  );
  assert.deepEqual(
    found("````\n```\nI made a mistake\n```\n````\nOk."),
    [],
    "a shorter fence inside does not close it",
  );
});

test("inline code is skipped, with any number of backticks", () => {
  assert.deepEqual(found("Set `message` to `I'm sorry` and save."), []);
  assert.deepEqual(found("Use ``Let me retry`` as the label."), []);
  assert.deepEqual(
    found("A lone ` backtick. Sorry about that."),
    ["apology:Sorry about that"],
    "an unclosed backtick is literal",
  );
});

// --- ranges, order and overlaps -----------------------------------------------------

test("ranges point at the phrase in the original text", () => {
  const text = "Run `make`. Sorry about that. Ok. Actually, never mind.";
  const matches = classifyReply(text);
  assert.deepEqual(covered(text, matches), ["Sorry about that", "Actually,"]);
  assert.deepEqual(
    matches.map((m) => [m.start, m.end]),
    [
      [12, 28],
      [34, 43],
    ],
  );
});

test("several phrases come back in text order", () => {
  const text = "You're right, my mistake. Let me try again.";
  assert.deepEqual(found(text), [
    "concession:You're right",
    "admission:My mistake",
    "retry:Let me try again",
  ]);
  assert.deepEqual(covered(text, classifyReply(text)), [
    "You're right",
    "my mistake",
    "Let me try again",
  ]);
});

test("overlapping phrases keep the one that starts first", () => {
  assert.deepEqual(found("I'm sorry about that."), ["apology:I'm sorry"]);
});

test("nothing to read", () => {
  assert.deepEqual(classifyReply(""), []);
  assert.deepEqual(classifyReply("The export finished: 42 rows."), []);
});

test("performance smoke: a 90 KB reply of unclosed quotes reads in one pass", () => {
  const text = `${"‘a “b ".repeat(15_000)}Sorry about that.`;
  const started = performance.now();
  const matches = classifyReply(text);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1_000, `read in ${Math.round(elapsed)} ms`);
  assert.deepEqual(covered(text, matches), ["Sorry about that"]);
});

test("every category has at least one phrase", () => {
  const seen = new Set(POSITIVES.map(([, expected]) => expected.split(":")[0]));
  assert.deepEqual(
    [...PHRASE_CATEGORIES].filter((category) => !seen.has(category)),
    [],
  );
});
