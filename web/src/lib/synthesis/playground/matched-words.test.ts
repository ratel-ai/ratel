import assert from "node:assert/strict";
import { test } from "node:test";
import { askTerms, highlight, sharedWords, stem, words } from "./matched-words";

test("stem folds the common endings so plural and singular meet", () => {
  assert.equal(stem("Flights"), "flight");
  assert.equal(stem("booking"), "book");
  assert.equal(stem("shipping"), "ship");
  assert.equal(stem("called"), "call");
  assert.equal(stem("policies"), "policy");
  assert.equal(stem("class"), "class");
  assert.equal(stem("bus"), "bus");
});

test("words breaks tool names the way a reader does", () => {
  assert.deepEqual(words("book_flight"), ["book", "flight"]);
  assert.deepEqual(words("getWeatherForecast"), ["get", "Weather", "Forecast"]);
  assert.deepEqual(words("find-hotel v2"), ["find", "hotel", "v2"]);
});

test("askTerms drops filler words and single letters", () => {
  assert.deepEqual(
    [...askTerms("I want to book a flight to Lisbon")],
    ["book", "flight", "lisbon"],
  );
});

test("sharedWords lists the ask's words a capability also uses, once each, in ask order", () => {
  assert.deepEqual(
    sharedWords("book a flight, flights to Lisbon", ["book_flight", "Books a seat on a flight."]),
    ["book", "flight"],
  );
  assert.deepEqual(sharedWords("weather in Porto", ["book_flight", "Books a seat."]), []);
});

test("highlight marks matched words and gives back the text exactly", () => {
  const text = "Books a seat on a flight.";
  const segments = highlight(text, askTerms("book flights"));
  assert.equal(segments.map((segment) => segment.text).join(""), text);
  assert.deepEqual(
    segments.filter((segment) => segment.match).map((segment) => segment.text),
    ["Books", "flight"],
  );
});

test("highlight leaves text untouched when there is nothing to mark", () => {
  assert.deepEqual(highlight("Plain text", new Set()), [{ text: "Plain text", match: false }]);
  assert.deepEqual(highlight("", askTerms("flight")), []);
});
