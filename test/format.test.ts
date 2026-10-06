import { describe, expect, it } from "vitest";
import { displayWidth, formatTable, plural } from "../src/format.js";

describe("plural", () => {
  it.each<[number, string]>([
    [0, "0 skills"],
    [1, "1 skill"],
    [2, "2 skills"],
  ])("counts %i", (count, text) => {
    expect(plural(count, "skill")).toBe(text);
  });
});

describe("displayWidth", () => {
  it.each<[string, number]>([
    ["", 0],
    ["demo-skill", 10],
    ["技能", 4],
    ["技能-demo", 9],
    ["ｄｅｍｏ", 8],
    ["한국어", 6],
    ["café", 4],
    ["cafe\u0301", 4],
    ["a\u200Bb", 2],
    ["🚀", 2],
    ["\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", 2],
    ["\u2764\uFE0F", 2],
    ["—", 1],
    ["✓", 1],
  ])("measures %j as %i columns", (text, width) => {
    expect(displayWidth(text)).toBe(width);
  });
});

describe("formatTable", () => {
  it("pads every column but the last to its widest cell, two spaces apart", () => {
    expect(formatTable([["A", "BB", "C"], ["aaa", "b", "c"]])).toEqual(["A    BB  C", "aaa  b   c"]);
  });

  it("aligns columns after wide and combining characters", () => {
    const [header, ...rows] = formatTable([["NAME", "PATH"], ["技能", "./a"], ["cafe\u0301", "./b"], ["🚀", "./c"]]);
    expect(header).toBe("NAME  PATH");
    for (const row of rows) expect(displayWidth(row.slice(0, row.indexOf("./")))).toBe(6);
  });

  it("does not pad the last column", () => {
    expect(formatTable([["A", "LONGEST"], ["b", "c"]])).toEqual(["A  LONGEST", "b  c"]);
  });
});
