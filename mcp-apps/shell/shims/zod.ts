/**
 * The console's modules declare their zod schemas as they load. A view gets data the server already
 * parsed and parses nothing, so here a schema is inert: zod's 320 KB stay out of every bundle. A
 * view that does parse fails loudly.
 */
const inert: unknown = new Proxy(() => {}, {
  get(_, name) {
    if (typeof name === "string" && /parse(Async)?$/i.test(name))
      return () => {
        throw new Error(`zod.${name}: a view parses nothing`);
      };
    // Not a promise, not iterable, no primitive value.
    return typeof name === "symbol" || name === "then" ? undefined : inert;
  },
  apply: () => inert,
});

// biome-ignore lint/suspicious/noExplicitAny: stands for the whole of zod.
export const z = inert as any;
export default z;
