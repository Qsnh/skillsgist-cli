import { describe, expect, it } from "vitest";
import { homePath, shortPath } from "../src/paths.js";

describe("shortPath", () => {
  it.each([
    ["/u/x/.agents/skills/demo", "/u/x", "/w", "~/.agents/skills/demo"],
    ["/u/x/.agents/skills/demo", "/u/x/", "/w", "~/.agents/skills/demo"],
    ["/u/x", "/u/x/", "/w", "~"],
    ["/w/.agents/skills/demo", "/u/x", "/w/", "./.agents/skills/demo"],
    ["/u/xy/demo", "/u/x", "/w", "/u/xy/demo"],
    ["/srv/demo", "/", "/w", "~/srv/demo"],
  ])("shortens %s with home %s and cwd %s", (path, home, cwd, short) => {
    expect(shortPath(path, home, cwd)).toBe(short);
  });
});

describe("homePath", () => {
  it.each([
    ["/u/x/.claude/skills", "/u/x", "~/.claude/skills"],
    ["/u/x", "/u/x/", "~"],
    ["/u/xy/skills", "/u/x", "/u/xy/skills"],
    ["/w/cfg/skills", "/u/x", "/w/cfg/skills"],
  ])("shortens %s with home %s, and nothing outside home", (path, home, short) => {
    expect(homePath(path, home)).toBe(short);
  });
});
