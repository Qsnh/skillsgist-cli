import { dirname, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgents } from "../src/agents.js";
import { agentSkillDir } from "../src/installer.js";
import { listAgents } from "../src/list-agents.js";

const none = () => false;
const only = (...paths: string[]) => (path: string) => paths.includes(path);
const list = (env: NodeJS.ProcessEnv = {}, exists: (path: string) => boolean = none) => listAgents({ home: "/h", cwd: "/w", env, exists });
const lines = (text: string) => text.split("\n");
const idOf = (line: string) => line.slice(3).split(" ")[0];
const row = (text: string, id: string) => lines(text).find((line) => idOf(line) === id)!;
const cells = (text: string, id: string) => row(text, id).slice(3).split(/ {2,}/);

describe("listAgents", () => {
  it("lists every agent -a accepts, sorted by id", () => {
    const text = list();
    expect(lines(text)[0]).toBe("72 agents. Pass their IDs to `skillsgist add <url> -a`; ✓ marks the ones detected on this machine or in the current directory.");
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
    expect(lines(text).filter((line) => line !== line.trimEnd())).toEqual([]);
  });

  it("shows the directories add installs into, in a project and with -g", () => {
    const env = { XDG_CONFIG_HOME: "/x", CODEX_HOME: "/h/codex" };
    const text = list(env);
    const scope = { copy: false, confirmed: false, home: "/h", cwd: "/w" };
    for (const agent of loadAgents({ home: "/h", cwd: "/w", env, exists: none })) {
      const project = agentSkillDir(agent, "s", { ...scope, global: false })!;
      const global = agentSkillDir(agent, "s", { ...scope, global: true });
      const shown = global === null ? "—" : dirname(global).replace(/^\/h\//, "~/");
      expect(cells(text, agent.id).slice(2)).toEqual([relative("/w", dirname(project)), shown]);
    }
    expect(cells(text, "codex")[3]).toBe("~/.agents/skills");
    expect(cells(text, "opencode")[3]).toBe("~/.agents/skills");
    expect(cells(text, "goose")[3]).toBe("/x/goose/skills");
  });

  it("ticks the agents detected on this machine or in the current directory", () => {
    const text = list({}, only("/h/.claude", "/etc/codex", "/w/data/skills"));
    expect(lines(text).filter((line) => line.startsWith("✓")).map(idOf)).toEqual(["astrbot", "claude-code", "codex"]);
  });

  it("marks agents without a global directory with a dash", () => {
    const text = list();
    expect(row(text, "promptscript")).toMatch(/ \.agents\/skills +—$/);
  });

  it("shows the global directory an override points to", () => {
    expect(row(list({ CLAUDE_CONFIG_DIR: "/c" }), "claude-code")).toMatch(/ \/c\/skills$/);
  });

  it("keeps a global directory outside home absolute, wherever it runs from", () => {
    expect(cells(list({ XDG_CONFIG_HOME: "/w/cfg" }), "goose")[3]).toBe("/w/cfg/goose/skills");
    expect(cells(list({ XDG_CONFIG_HOME: "/etc/xdg" }), "goose")[3]).toBe("/etc/xdg/goose/skills");
  });

  it("strips terminal escapes an override smuggles in", () => {
    const text = list({ CLAUDE_CONFIG_DIR: "/c\x1b]52;c;ZXZpbA==\x07" });
    expect(text).not.toMatch(/[\x1b\x07]/);
    expect(row(text, "claude-code")).toMatch(/ \/c\]52;c;ZXZpbA==\/skills$/);
  });

  it("keeps each agent on one line when an override holds a newline or a tab", () => {
    const text = list({ CLAUDE_CONFIG_DIR: "/c\n✓  evil  Evil  .evil/skills  /evil\tx" });
    expect(lines(text)).toHaveLength(lines(list()).length);
    expect(lines(text).filter((line) => line.startsWith("✓"))).toEqual([]);
    expect(row(text, "claude-code")).toMatch(/ \/c ✓  evil  Evil  \.evil\/skills  \/evil x\/skills$/);
  });

  it("says what add installs for without -a inside an agent", () => {
    expect(lines(list({ CLAUDECODE: "1" }))[1]).toBe(
      "Inside Claude Code, `skillsgist add <url>` without -a installs for claude-code and the agents that read .agents/skills, whatever is ticked.",
    );
    expect(lines(list({ AI_AGENT: "mystery" }))[1]).toBe(
      "Inside an agent, `skillsgist add <url>` without -a installs for the ticked agents and the agents that read .agents/skills.",
    );
    expect(lines(list({ CLAUDECODE: "1" })).slice(2)).toEqual(lines(list()).slice(1));
  });
});
