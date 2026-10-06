import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectRunningAgent, loadAgents, type Agent } from "../src/agents.js";
import { cleanup, sandboxExists, tempDir } from "./helpers/fs.js";

afterEach(cleanup);

const none = () => false;
const only = (...paths: string[]) => (path: string) => paths.includes(path);
const load = (env: NodeJS.ProcessEnv = {}, exists: (path: string) => boolean = none) => loadAgents({ home: "/h", cwd: "/w", env, exists });
const byId = (agents: Agent[], id: string) => agents.find((agent) => agent.id === id)!;

describe("loadAgents", () => {
  it("knows the 73 agents of skills 1.5.18, each once", () => {
    const ids = load().map((agent) => agent.id);
    expect(ids).toHaveLength(73);
    expect(new Set(ids).size).toBe(73);
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

  it("leaves only Eve out of the agent picker", () => {
    expect(load().filter((agent) => !agent.pickable).map((agent) => agent.id)).toEqual(["eve"]);
  });

  it("resolves global directories from the home directory", () => {
    const agents = load();
    expect(byId(agents, "claude-code").globalDir).toBe("/h/.claude/skills");
    expect(byId(agents, "windsurf").globalDir).toBe("/h/.codeium/windsurf/skills");
    expect(byId(agents, "opencode").globalDir).toBe("/h/.config/opencode/skills");
    expect(byId(agents, "eve").globalDir).toBeNull();
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

  it("picks OpenClaw's legacy directory when only that one exists", () => {
    expect(byId(load({}, only("/h/.clawdbot")), "openclaw").globalDir).toBe("/h/.clawdbot/skills");
  });

  it("detects Eve only with an agent directory and an eve dependency", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "agent"));
    const eve = () => byId(loadAgents({ home: "/h", cwd, env: {}, exists: sandboxExists(cwd) }), "eve").installed;
    expect(eve()).toBe(false);
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ dependencies: { eve: "1.0.0" } }));
    expect(eve()).toBe(true);
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
    expect(detectRunningAgent(env, none)).toEqual({ inAgent: true, id });
  });

  it("treats a bare Cursor terminal as no agent, even with Claude Code inside it", () => {
    expect(detectRunningAgent({ CURSOR_TRACE_ID: "t", CLAUDECODE: "1" }, none)).toEqual({ inAgent: false, id: null });
  });

  it("maps Devin's marker file to the universal directory", () => {
    expect(detectRunningAgent({}, only("/opt/.devin"))).toEqual({ inAgent: true, id: "universal" });
  });

  it("reports no agent in a plain shell", () => {
    expect(detectRunningAgent({}, none)).toEqual({ inAgent: false, id: null });
  });
});
