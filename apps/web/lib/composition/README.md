# `lib/composition` (L0)

The composition root. `RATEL_COMPOSITION` (`oss`, the default, or `cloud`) selects which set of
port implementations is mounted; a missing port stops the process at startup
(`instrumentation.node.ts`), never on the first request.

- `index.ts` — `createComposition` and the `composition` singleton the core reads.
- `ee-absent.ts` — what the `#ee-composition` alias resolves to when `ee/src` is absent: `null`.

With ADR-0030 the root splits in two: `ports.ts` (the ports; imports no module) and
`registry.ts` (collects every module's `register.ts`; the one file allowed to import any layer).
