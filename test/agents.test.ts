import { describe, expect, it } from "vitest";
import { detectRunningAgent, loadAgents, skillsRoot, type Agent } from "../src/agents.js";

const none = () => false;
const only = (...paths: string[]) => (path: string) => paths.includes(path);
const load = (env: NodeJS.ProcessEnv = {}, exists: (path: string) => boolean = none) => loadAgents({ home: "/h", cwd: "/w", env, exists });
const byId = (agents: Agent[], id: string) => agents.find((agent) => agent.id === id)!;

describe("loadAgents", () => {
  it("knows 72 agents, each once", () => {
    const ids = load().map((agent) => agent.id);
    expect(ids).toHaveLength(72);
    expect(new Set(ids).size).toBe(72);
  });

  it("puts the 17 universal agents in .agents/skills and hides four of them", () => {
    const agents = load();
    expect(agents.filter((agent) => agent.universal).map((agent) => agent.id)).toEqual([
      "amp", "antigravity", "antigravity-cli", "cline", "codex", "cursor", "deepagents", "dexto", "firebender",
      "gemini-cli", "github-copilot", "kimi-code-cli", "loaf", "opencode", "warp", "zed", "promptscript",
    ]);
    expect(agents.filter((agent) => agent.hidden).map((agent) => agent.id)).toEqual(["dexto", "firebender", "loaf", "promptscript"]);
    expect(byId(agents, "replit")).toMatchObject({ canonical: true, universal: false });
    expect(byId(agents, "universal")).toMatchObject({ canonical: true, universal: false });
  });

  it("marks the agents whose project folder -y never replaces", () => {
    expect(load().filter((agent) => agent.projectOwned).map((agent) => agent.id)).toEqual(["astrbot", "openclaw"]);
  });

  it("resolves global directories from the home directory", () => {
    const agents = load();
    expect(byId(agents, "claude-code").globalDir).toBe("/h/.claude/skills");
    expect(byId(agents, "windsurf").globalDir).toBe("/h/.codeium/windsurf/skills");
    expect(byId(agents, "opencode").globalDir).toBe("/h/.config/opencode/skills");
    expect(byId(agents, "promptscript").globalDir).toBeNull();
  });

  it("honours the agents' home overrides and ignores blank ones", () => {
    const agents = load({ CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "  ", XDG_CONFIG_HOME: "/x" });
    expect(byId(agents, "claude-code").globalDir).toBe("/c/skills");
    expect(byId(agents, "codex").globalDir).toBe("/h/.codex/skills");
    expect(byId(agents, "opencode").globalDir).toBe("/x/opencode/skills");
    expect(byId(agents, "crush").globalDir).toBe("/h/.config/crush/skills");
  });

  it("detects agents by their marker paths", () => {
    const agents = load({}, only("/h/.claude", "/h/.codeium/windsurf", "/etc/codex"));
    expect(agents.filter((agent) => agent.installed).map((agent) => agent.id)).toEqual(["claude-code", "codex", "windsurf"]);
  });

  it.each([["/w/.astrbot"], ["/w/data/cmd_config.json"], ["/h/.astrbot"]])("detects AstrBot by %s", (marker) => {
    expect(byId(load({}, only(marker)), "astrbot").installed).toBe(true);
  });

  it("does not take a project's data/skills folder for AstrBot", () => {
    expect(byId(load({}, only("/w/data", "/w/data/skills")), "astrbot").installed).toBe(false);
  });

  it("picks OpenClaw's legacy directory when only that one exists", () => {
    expect(byId(load({}, only("/h/.clawdbot")), "openclaw").globalDir).toBe("/h/.clawdbot/skills");
  });
});

describe("skillsRoot", () => {
  const root = (id: string, global: boolean) => skillsRoot(byId(load({ XDG_CONFIG_HOME: "/x" }), id), { global, home: "/h", cwd: "/w" });

  it("puts every agent that reads .agents/skills in the shared folder, even with -g", () => {
    expect(root("codex", false)).toBe("/w/.agents/skills");
    expect(root("codex", true)).toBe("/h/.agents/skills");
    expect(root("opencode", true)).toBe("/h/.agents/skills");
    expect(root("universal", true)).toBe("/h/.agents/skills");
  });

  it("uses the other agents' own folders", () => {
    expect(root("claude-code", false)).toBe("/w/.claude/skills");
    expect(root("claude-code", true)).toBe("/h/.claude/skills");
    expect(root("goose", true)).toBe("/x/goose/skills");
  });

  it("has no global folder for agents that cannot install globally", () => {
    expect(root("promptscript", true)).toBeNull();
    expect(root("promptscript", false)).toBe("/w/.agents/skills");
  });
});

describe("detectRunningAgent", () => {
  it.each<[NodeJS.ProcessEnv, string | null]>([
    [{ CLAUDECODE: "1" }, "claude-code"],
    [{ CLAUDE_CODE: "1", CLAUDE_CODE_IS_COWORK: "1" }, "claude-code"],
    [{ CODEX_SANDBOX: "seatbelt" }, "codex"],
    [{ GEMINI_CLI: "1" }, "gemini-cli"],
    [{ OPENCODE_CLIENT: "cli" }, "opencode"],
    [{ CURSOR_AGENT: "1" }, "cursor"],
    [{ CURSOR_TRACE_ID: "t", CURSOR_AGENT: "1" }, "cursor"],
    [{ AUGMENT_AGENT: "1" }, "augment"],
    [{ ANTIGRAVITY_AGENT: "1" }, "antigravity"],
    [{ COPILOT_MODEL: "x" }, "github-copilot"],
    [{ REPL_ID: "r" }, "replit"],
    [{ AI_AGENT: "claude-code" }, "claude-code"],
    [{ AI_AGENT: "github-copilot-cli" }, "github-copilot"],
    [{ AI_AGENT: "claude-code_2-1-280_harness", CLAUDECODE: "1" }, "claude-code"],
    [{ AI_AGENT: "claude-code_2-1-280_agent" }, "claude-code"],
    [{ AI_AGENT: "github-copilot-cli/1.0" }, "github-copilot"],
    [{ AI_AGENT: "v0", CLAUDECODE: "1" }, "claude-code"],
    [{ AI_AGENT: "v0" }, null],
    [{ AI_AGENT: "v0", CURSOR_TRACE_ID: "t" }, null],
    [{ AI_AGENT: "cursor" }, "cursor"],
    [{ AI_AGENT: "cursor-cli" }, "cursor"],
    [{ AI_AGENT: "cursor-cli", CURSOR_TRACE_ID: "t" }, "cursor"],
    [{ AI_AGENT: "toString" }, null],
    [{ AI_AGENT: "constructor", CLAUDECODE: "1" }, "claude-code"],
  ])("maps %j to %s", (env, id) => {
    expect(detectRunningAgent(env, none)).toMatchObject({ inAgent: true, id });
  });

  it.each<[NodeJS.ProcessEnv, string | null]>([
    [{ CLAUDECODE: "1" }, "Claude Code"],
    [{ AI_AGENT: "cursor-cli" }, "Cursor"],
    [{ AI_AGENT: "devin" }, "Devin"],
    [{ AI_AGENT: "v0" }, null],
  ])("names the agent behind %j %s", (env, name) => {
    expect(detectRunningAgent(env, none).name).toBe(name);
  });

  it("treats a bare Cursor terminal as no agent", () => {
    expect(detectRunningAgent({ CURSOR_TRACE_ID: "t" }, none)).toEqual({ inAgent: false, id: null, name: null });
  });

  it.each<[NodeJS.ProcessEnv, string]>([
    [{ CURSOR_TRACE_ID: "t", CLAUDECODE: "1" }, "claude-code"],
    [{ CURSOR_TRACE_ID: "t", CODEX_THREAD_ID: "x" }, "codex"],
    [{ CURSOR_TRACE_ID: "t", GEMINI_CLI: "1" }, "gemini-cli"],
  ])("finds the agent running in a Cursor terminal from %j", (env, id) => {
    expect(detectRunningAgent(env, none)).toMatchObject({ inAgent: true, id });
  });

  it("maps Devin's marker file to the universal directory and still calls it Devin", () => {
    expect(detectRunningAgent({}, only("/opt/.devin"))).toEqual({ inAgent: true, id: "universal", name: "Devin" });
  });

  it("reports no agent in a plain shell", () => {
    expect(detectRunningAgent({}, none)).toEqual({ inAgent: false, id: null, name: null });
  });
});
