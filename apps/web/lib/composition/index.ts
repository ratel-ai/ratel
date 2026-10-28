// The ports root. Kept as the `@/lib/composition` entry so `instrumentation.node.ts` and the
// runtime keep one import; `registry.ts` is imported only by the roots that need job handlers.
export {
  type Composition,
  type CompositionPorts,
  type CreateCompositionOptions,
  composition,
  createComposition,
  type NavItem,
} from "@/lib/composition/ports";
