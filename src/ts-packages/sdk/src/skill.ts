import type { Skill } from "./types.js";

/**
 * Helper for declaring a skill (a "molecule" — a labeled subgraph of tool atoms).
 * Mirrors `tool()` for symmetry; just normalizes the shape so callers don't need
 * to remember which fields are optional on the wire.
 */
export function skill(def: Skill): Skill {
  return {
    name: def.name,
    description: def.description,
    ...(def.intent !== undefined ? { intent: def.intent } : {}),
    atoms: def.atoms,
    ...(def.edges ? { edges: def.edges } : {}),
    ...(def.metadata ? { metadata: def.metadata } : {}),
  };
}
