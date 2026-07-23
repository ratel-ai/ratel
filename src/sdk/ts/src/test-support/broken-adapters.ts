import type { RatelAdapter } from "../index.js";
import {
  type FakeExt,
  type FakeMessage,
  type FakeTool,
  referenceAdapter,
} from "../testkit/reference-adapter.js";

// Deliberately non-conformant adapter variants, each breaking exactly one facet
// of the SPI contract. They exist only to prove the conformance battery
// discriminates — a variant that breaks facet X must fail X's cases while the
// rest stay green — so they are never shipped (this dir is build-excluded).

type Reference = RatelAdapter<FakeTool, FakeMessage, FakeExt>;

/** `ingest` drops the description, so retrieval can never rank the tool. */
export function lossyIngest(): Reference {
  return {
    ...referenceAdapter(),
    ingest(_id, tool) {
      if (!tool.execute) return "passthrough";
      return { description: "", inputSchema: tool.inputSchema, execute: tool.execute };
    },
  };
}

/** `ingest` ignores the framework executor and returns a constant instead. */
export function inertIngest(): Reference {
  return {
    ...referenceAdapter(),
    ingest(_id, tool) {
      if (!tool.execute) return "passthrough";
      return {
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: () => ({ inert: true }),
      };
    },
  };
}

/** `ingest` passes everything through, so executables never land in the catalog. */
export function passthroughAlways(): Reference {
  return {
    ...referenceAdapter(),
    ingest() {
      return "passthrough";
    },
  };
}

/** `ingest` never passes through, cataloging provider-run tools that should stay passthroughs. */
export function passthroughNever(): Reference {
  return {
    ...referenceAdapter(),
    ingest(_id, tool) {
      return {
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: tool.execute ?? (() => ({})),
      };
    },
  };
}

/** `expose` leaks a raw-tool `id`, so the exposed object is not framework-shaped. */
export function rawExpose(): Reference {
  const base = referenceAdapter();
  return {
    ...base,
    expose(tool) {
      return { ...base.expose(tool), id: "leaked" } as FakeTool;
    },
  };
}

/** `recallMessages` mints a constant call id, so ids are not monotonic. */
export function fixedCallId(): RatelAdapter<FakeTool, FakeMessage> {
  return {
    ...referenceAdapter(),
    recallMessages(ref, recall) {
      return [
        { role: "call", callId: "recall_0", body: { query: ref.query } },
        { role: "result", callId: "recall_0", body: recall },
      ];
    },
  };
}

/** `recallMessages` drops the result message, so the pair is malformed. */
export function droppedResult(): RatelAdapter<FakeTool, FakeMessage> {
  return {
    ...referenceAdapter(),
    recallMessages(ref) {
      return [{ role: "call", callId: ref.callId, body: { query: ref.query } }];
    },
  };
}

/** `extend` shadows the base `modelTools`, clobbering the model-facing surface. */
export function shadowingExtend(): RatelAdapter<FakeTool, FakeMessage> {
  return {
    ...referenceAdapter(),
    extend: () => ({ modelTools: () => ({}) }),
  };
}

/** The adapter carries an empty `name`. */
export function namelessAdapter(): Reference {
  return { ...referenceAdapter(), name: "" };
}
