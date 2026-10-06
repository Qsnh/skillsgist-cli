import { describe, expect, it } from "vitest";
import { loadAgents } from "../src/agents.js";
import { listAgents } from "../src/list-agents.js";

const none = () => false;
const only = (...paths: string[]) => (path: string) => paths.includes(path);
const list = (env: NodeJS.ProcessEnv = {}, exists: (path: string) => boolean = none) => listAgents({ home: "/h", cwd: "/w", env, exists });
const lines = (text: string) => text.split("\n");
const idOf = (line: string) => line.slice(3).split(" ")[0];
const row = (text: string, id: string) => lines(text).find((line) => idOf(line) === id)!;

describe("listAgents", () => {
  it("lists every agent -a accepts, sorted by id", () => {
    const text = list();
    expect(lines(text)[0]).toBe("73 agents. Pass their IDs to `skillsgist add <url> -a`; ✓ marks the ones detected here.");
    expect(lines(text)[1]).toBe("");
    const known = loadAgents({ home: "/h", cwd: "/w", env: {}, exists: none }).map((agent) => agent.id);
    expect(lines(text).slice(3, -1).map(idOf)).toEqual([...known].sort());
    expect(text.endsWith("\n")).toBe(true);
  });

  it("shows each agent's name and directories in aligned columns", () => {
    const text = list();
    const header = lines(text)[2];
    const claude = row(text, "claude-code");
    expect(header).toMatch(/^ {3}ID +NAME +PROJECT +GLOBAL$/);
    expect(claude).toMatch(/^ {3}claude-code +Claude Code +\.claude\/skills +~\/\.claude\/skills$/);
    expect(claude.indexOf(".claude/skills")).toBe(header.indexOf("PROJECT"));
    expect(claude.indexOf("~/.claude/skills")).toBe(header.indexOf("GLOBAL"));
    expect(row(text, "opencode")).toMatch(/ \.agents\/skills +~\/\.config\/opencode\/skills$/);
  });

  it("ticks the agents detected on this machine", () => {
    const text = list({}, only("/h/.claude", "/etc/codex"));
    expect(lines(text).filter((line) => line.startsWith("✓")).map(idOf)).toEqual(["claude-code", "codex"]);
  });

  it("marks agents without a global directory with a dash", () => {
    const text = list();
    expect(row(text, "eve")).toMatch(/ agent\/skills +—$/);
    expect(row(text, "promptscript")).toMatch(/ \.agents\/skills +—$/);
  });

  it("shows the global directory an override points to", () => {
    expect(row(list({ CLAUDE_CONFIG_DIR: "/c" }), "claude-code")).toMatch(/ \/c\/skills$/);
  });

  it("strips terminal escapes an override smuggles in", () => {
    const text = list({ CLAUDE_CONFIG_DIR: "/c\x1b]52;c;ZXZpbA==\x07" });
    expect(text).not.toMatch(/[\x1b\x07]/);
    expect(row(text, "claude-code")).toMatch(/ \/c\]52;c;ZXZpbA==\/skills$/);
  });
});
