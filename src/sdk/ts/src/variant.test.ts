import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExperimentalVariantSpanProcessor, experimentalWithVariant } from "./index.js";

let exporter: InMemorySpanExporter;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({
      spanProcessors: [new ExperimentalVariantSpanProcessor(), new SimpleSpanProcessor(exporter)],
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  context.disable();
  trace.disable();
});

function span(name: string): ReadableSpan {
  const found = exporter.getFinishedSpans().find((s) => s.name === name);
  if (found === undefined) throw new Error(`no span named ${name}`);
  return found;
}

function variantAttributes(s: ReadableSpan): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(s.attributes).filter(([key]) => key.startsWith("ratel.variant.")),
  );
}

const tracer = () => trace.getTracer("variant-test");

describe("experimentalWithVariant", () => {
  it("tags the root span and nested spans of the run, also across an await", async () => {
    await experimentalWithVariant(
      {
        experiment: "support-model",
        name: "haiku",
        model: "claude-haiku-5-5",
        prompt_version: 3,
        cached: true,
      },
      async () => {
        await tracer().startActiveSpan("root", async (root) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          tracer().startActiveSpan("child", (child) => child.end());
          root.end();
        });
      },
    );

    const expected = {
      "ratel.variant.experiment": "support-model",
      "ratel.variant.name": "haiku",
      "ratel.variant.model": "claude-haiku-5-5",
      "ratel.variant.prompt_version": 3,
      "ratel.variant.cached": true,
    };
    expect(variantAttributes(span("root"))).toEqual(expected);
    expect(variantAttributes(span("child"))).toEqual(expected);
  });

  it("leaves spans outside the callback untagged", async () => {
    tracer().startSpan("before").end();
    const result = experimentalWithVariant({ experiment: "e", name: "a" }, () => 42);
    tracer().startSpan("after").end();

    expect(result).toBe(42);
    expect(variantAttributes(span("before"))).toEqual({});
    expect(variantAttributes(span("after"))).toEqual({});
  });

  it("sets the tags as string baggage for propagation to other processes", () => {
    experimentalWithVariant({ experiment: "e", name: "a", temperature: 0.5, cached: false }, () => {
      const baggage = propagation.getBaggage(context.active());
      expect(baggage?.getEntry("ratel.variant.experiment")?.value).toBe("e");
      expect(baggage?.getEntry("ratel.variant.name")?.value).toBe("a");
      expect(baggage?.getEntry("ratel.variant.temperature")?.value).toBe("0.5");
      expect(baggage?.getEntry("ratel.variant.cached")?.value).toBe("false");
    });
  });

  it("lets an inner call replace every tag of the outer call", () => {
    experimentalWithVariant({ experiment: "outer", name: "a", model: "m1" }, () => {
      experimentalWithVariant({ experiment: "inner", name: "b" }, () => {
        tracer().startSpan("inner").end();
      });
    });

    expect(variantAttributes(span("inner"))).toEqual({
      "ratel.variant.experiment": "inner",
      "ratel.variant.name": "b",
    });
  });

  it("refuses an invalid experiment or name and does not run the callback", () => {
    const fn = vi.fn();
    expect(() => experimentalWithVariant({ experiment: "", name: "a" }, fn)).toThrow(TypeError);
    expect(() => experimentalWithVariant({ experiment: "e", name: "x".repeat(129) }, fn)).toThrow(
      TypeError,
    );
    expect(() =>
      experimentalWithVariant({ experiment: 3 as unknown as string, name: "a" }, fn),
    ).toThrow(TypeError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("drops invalid descriptors with a warning and keeps the valid ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    experimentalWithVariant(
      {
        experiment: "e",
        name: "a",
        model: "ok",
        "Bad.Key": "x",
        empty: "",
        long: "x".repeat(129),
        nan: Number.NaN,
        nothing: null as unknown as string,
        list: ["a"] as unknown as string,
        nested: { a: 1 } as unknown as string,
      },
      () => tracer().startSpan("run").end(),
    );

    expect(variantAttributes(span("run"))).toEqual({
      "ratel.variant.experiment": "e",
      "ratel.variant.name": "a",
      "ratel.variant.model": "ok",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("Bad.Key");
    expect(warn.mock.calls[0]?.[0]).toContain("nested");
  });

  it("keeps the first 16 descriptors in key order", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const descriptors = Object.fromEntries(
      Array.from({ length: 18 }, (_, i) => [`k${String(i).padStart(2, "0")}`, i]),
    );
    experimentalWithVariant({ experiment: "e", name: "a", ...descriptors }, () =>
      tracer().startSpan("run").end(),
    );

    const attributes = variantAttributes(span("run"));
    expect(Object.keys(attributes)).toHaveLength(18);
    expect(attributes["ratel.variant.k15"]).toBe(15);
    expect(attributes["ratel.variant.k16"]).toBeUndefined();
  });
});

describe("ExperimentalVariantSpanProcessor", () => {
  it("copies variant baggage from another process onto spans as strings", () => {
    const baggage = propagation.createBaggage({
      "ratel.variant.experiment": { value: "e" },
      "ratel.variant.name": { value: "a" },
      "ratel.variant.prompt_version": { value: "3" },
      "ratel.variant.Bad.Key": { value: "x" },
      "other.key": { value: "y" },
    });
    context.with(propagation.setBaggage(context.active(), baggage), () => {
      tracer().startSpan("remote").end();
    });

    expect(variantAttributes(span("remote"))).toEqual({
      "ratel.variant.experiment": "e",
      "ratel.variant.name": "a",
      "ratel.variant.prompt_version": "3",
    });
  });

  it("ignores variant baggage without an experiment and a name", () => {
    const baggage = propagation.createBaggage({ "ratel.variant.model": { value: "m" } });
    context.with(propagation.setBaggage(context.active(), baggage), () => {
      tracer().startSpan("partial").end();
    });

    expect(variantAttributes(span("partial"))).toEqual({});
  });
});
