import { describe, it, expect } from "vitest";
import {
  toolMatchesSlot,
  slotRecall,
  slotPrecision,
  flattenSlots,
  formatSlots,
  type ToolSlot,
} from "./tool-slots.js";

describe("toolMatchesSlot", () => {
  it("matches a plain string slot", () => {
    expect(toolMatchesSlot("getSalary", "getSalary")).toBe(true);
  });

  it("rejects a non-matching string slot", () => {
    expect(toolMatchesSlot("getSalary", "getEmployee")).toBe(false);
  });

  it("matches any alternative in an array slot", () => {
    expect(toolMatchesSlot("searchEmployees", ["getEmployee", "searchEmployees"])).toBe(true);
    expect(toolMatchesSlot("getEmployee", ["getEmployee", "searchEmployees"])).toBe(true);
  });

  it("rejects tool not in array slot", () => {
    expect(toolMatchesSlot("listEmployees", ["getEmployee", "searchEmployees"])).toBe(false);
  });
});

describe("slotRecall", () => {
  it("returns 1 when all slots satisfied", () => {
    const slots: ToolSlot[] = [["getEmployee", "searchEmployees"], "getSalary"];
    expect(slotRecall(["searchEmployees", "getSalary"], slots)).toBe(1);
  });

  it("returns fraction for partial coverage", () => {
    const slots: ToolSlot[] = [["getEmployee", "searchEmployees"], "getSalary"];
    expect(slotRecall(["searchEmployees"], slots)).toBe(0.5);
  });

  it("returns 0 when no slots satisfied", () => {
    const slots: ToolSlot[] = ["getEmployee", "getSalary"];
    expect(slotRecall(["createEmployee"], slots)).toBe(0);
  });

  it("returns 1 for empty slots", () => {
    expect(slotRecall(["getEmployee"], [])).toBe(1);
  });

  it("returns 1 for empty called and empty slots", () => {
    expect(slotRecall([], [])).toBe(1);
  });

  it("deduplicates called tools", () => {
    const slots: ToolSlot[] = ["getEmployee"];
    expect(slotRecall(["getEmployee", "getEmployee"], slots)).toBe(1);
  });
});

describe("slotPrecision", () => {
  it("returns 1 when all called tools match a slot", () => {
    const slots: ToolSlot[] = [["getEmployee", "searchEmployees"], "getSalary"];
    expect(slotPrecision(["searchEmployees", "getSalary"], slots)).toBe(1);
  });

  it("returns fraction when some called tools are extra", () => {
    const slots: ToolSlot[] = ["getSalary"];
    expect(slotPrecision(["getSalary", "createEmployee"], slots)).toBe(0.5);
  });

  it("returns 0 when no called tools match any slot", () => {
    const slots: ToolSlot[] = ["getEmployee"];
    expect(slotPrecision(["createEmployee", "listAssets"], slots)).toBe(0);
  });

  it("returns 1 when nothing called and nothing expected", () => {
    expect(slotPrecision([], [])).toBe(1);
  });

  it("returns 1 when nothing called but tools expected", () => {
    expect(slotPrecision([], ["getEmployee"])).toBe(1);
  });

  it("returns 0 when tools called but none expected", () => {
    expect(slotPrecision(["getEmployee"], [])).toBe(0);
  });
});

describe("flattenSlots", () => {
  it("flattens mixed string and array slots", () => {
    const slots: ToolSlot[] = [["getEmployee", "searchEmployees"], "getSalary"];
    expect(flattenSlots(slots)).toEqual(["getEmployee", "searchEmployees", "getSalary"]);
  });

  it("returns empty for empty slots", () => {
    expect(flattenSlots([])).toEqual([]);
  });

  it("deduplicates across slots", () => {
    const slots: ToolSlot[] = ["getEmployee", ["getEmployee", "searchEmployees"]];
    const result = flattenSlots(slots);
    expect(result).toEqual(["getEmployee", "searchEmployees"]);
  });
});

describe("formatSlots", () => {
  it("formats string slots as-is", () => {
    expect(formatSlots(["getSalary"])).toBe("getSalary");
  });

  it("formats array slots with pipe separator", () => {
    const slots: ToolSlot[] = [["getEmployee", "searchEmployees"], "getSalary"];
    expect(formatSlots(slots)).toBe("getEmployee|searchEmployees, getSalary");
  });

  it("returns (none) for empty slots", () => {
    expect(formatSlots([])).toBe("(none)");
  });
});
