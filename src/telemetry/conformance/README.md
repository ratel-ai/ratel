# conformance

The shared **contract-against-the-pin** fixtures for the telemetry helpers.

`fixtures.json` is one canonical set of `(scenario -> expected emitted span name + attributes + events)`.
Each **consuming** language helper's conformance test loads it, builds each span **from its own
`ratel.*` constants through the real OpenTelemetry SDK**, and asserts the emitted span matches
`expect_name` / `expect_attributes` / `expect_events` exactly. A constant that drifts from the
pinned convention (`../CONVENTIONS.md`) fails here, and it fails identically in the consuming
languages because the expectations live in one file.

## Fixture shape

| Field | Meaning |
|---|---|
| `span` | logical span id, mapped by the test to a span-name constant (e.g. `execute_tool` → `EXECUTE_TOOL`, `ratel_search` → `RATEL_SEARCH`) |
| `set` | attributes to set, by logical id mapped to an attribute-key constant (e.g. `ratel_origin` → `RATEL_ORIGIN`) |
| `add_events` | optional span events to add, by logical id mapped to an event-name constant (e.g. `ratel_search_results` → `RATEL_SEARCH_RESULTS`) |
| `expect_name` | the exact wire span name the pin requires |
| `expect_attributes` | the exact wire attribute keys + values the pin requires |
| `expect_events` | optional; the exact wire event names the pin requires (empty when omitted) |

The logical ids in `span` / `set` / `add_events` are the constant names lowercased; each helper
keeps a small map from logical id to its own constant, and those maps are the unit under test.

## Consumers

- **TS** — `../ts/src/conformance.test.ts`
- **Python** — `../python/tests/test_conformance.py`

The Rust conformance leg lands with the Rust `init()` builder (deferred to the server work, to
keep the constants crate dependency-free); it will consume this same `fixtures.json`.
