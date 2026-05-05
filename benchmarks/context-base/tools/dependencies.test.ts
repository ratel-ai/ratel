import { describe, it, expect } from "vitest";
import { TOOL_DEPENDENCIES } from "./dependencies.js";
import { toolRegistry, TOOL_CATEGORIES } from "./registry.js";

/** All categories covered by the dependency map */
const ANNOTATED_CATEGORIES = [
  "employees",
  "payroll",
  "benefits",
  "timeoff",
  "onboarding",
  "recruiting",
  "performance",
  "training",
  "crm",
  "it",
  "projects",
  "finance",
  "procurement",
  "legal",
  "facilities",
  "communications",
  "compliance",
  "reporting",
] as const;

describe("TOOL_DEPENDENCIES", () => {
  it("every key exists in the tool registry", () => {
    for (const name of Object.keys(TOOL_DEPENDENCIES)) {
      expect(toolRegistry[name], `${name} not in registry`).toBeDefined();
    }
  });

  it("covers only annotated categories", () => {
    const annotatedToolNames = new Set(
      ANNOTATED_CATEGORIES.flatMap((cat) => TOOL_CATEGORIES[cat]),
    );
    for (const name of Object.keys(TOOL_DEPENDENCIES)) {
      expect(annotatedToolNames.has(name), `${name} not in annotated categories`).toBe(true);
    }
  });

  it("every annotated category has at least one dependency entry", () => {
    for (const cat of ANNOTATED_CATEGORIES) {
      const toolNames = TOOL_CATEGORIES[cat];
      const hasEntry = toolNames.some((name) => TOOL_DEPENDENCIES[name] !== undefined);
      expect(hasEntry, `category "${cat}" has no dependency entries`).toBe(true);
    }
  });

  it("every requires param has at least one provider", () => {
    // Build set of all provided params
    const allProvided = new Set<string>();
    for (const dep of Object.values(TOOL_DEPENDENCIES)) {
      for (const p of dep.provides ?? []) {
        allProvided.add(p);
      }
    }

    for (const [name, dep] of Object.entries(TOOL_DEPENDENCIES)) {
      for (const r of dep.requires ?? []) {
        expect(
          allProvided.has(r),
          `${name} requires "${r}" but no tool provides it`,
        ).toBe(true);
      }
    }
  });

  it("no tool has self-cycles (provides what it requires)", () => {
    for (const [name, dep] of Object.entries(TOOL_DEPENDENCIES)) {
      const provides = new Set(dep.provides ?? []);
      for (const r of dep.requires ?? []) {
        expect(
          provides.has(r),
          `${name} both provides and requires "${r}"`,
        ).toBe(false);
      }
    }
  });

  it("has at least one tool with provides and one with requires", () => {
    const hasProvides = Object.values(TOOL_DEPENDENCIES).some(
      (d) => d.provides && d.provides.length > 0,
    );
    const hasRequires = Object.values(TOOL_DEPENDENCIES).some(
      (d) => d.requires && d.requires.length > 0,
    );
    expect(hasProvides).toBe(true);
    expect(hasRequires).toBe(true);
  });

  it("searchEmployees provides employeeId", () => {
    expect(TOOL_DEPENDENCIES.searchEmployees?.provides).toContain("employeeId");
  });

  it("getSalary requires employeeId", () => {
    expect(TOOL_DEPENDENCIES.getSalary?.requires).toContain("employeeId");
  });
});
