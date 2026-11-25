# Sample envelopes: the cross-language contract

Each `.bin` file is one queued ingest message as it is on the queue (ADR-0009, the codec is
`../envelope.ts`). Every implementation, in any language, must read and write these files byte
for byte. The Go repository `ratel-ingest-gateway` copies them and tests against them.

| File | Holds |
|---|---|
| `traces-protobuf.bin` | traces, protobuf, not compressed |
| `traces-json-gzip.bin` | traces, JSON, gzip |
| `logs-json.bin` | logs, JSON, from a shared (append-only) key, with characters in the body that JSON encoders escape differently |
| `events-json.bin` | runtime events |
| `newer-version.bin` | a version 2 frame with another layout: refuse it by its version, with a clear error, before reading the rest |

The `.json` file next to a `.bin` file states its decoded fields, and the body's length and
SHA-256. A conforming implementation:

1. decodes each `.bin` file to the fields in its `.json` file;
2. encodes them again, with the same body, to the same bytes;
3. refuses `newer-version.bin`, and the error names the version.

A body is opaque to the codec. Do not decompress it, parse it or write it again.

## Rules

- All content is made up. Never add customer data.
- A file here never changes. Any change to the frame or the header is a new envelope version,
  with new samples beside the old ones, and readers learn it before any writer sends it.
