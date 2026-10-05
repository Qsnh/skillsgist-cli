import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgents } from "../src/agents.js";
import { agentSkillDir, existingTargets, installSkill, sanitizeName, type InstallOptions } from "../src/installer.js";
import { cleanup, tempDir } from "./helpers/fs.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, symlink: vi.fn(actual.symlink) };
});

afterEach(cleanup);

const encode = (text: string) => new TextEncoder().encode(text);
const files = new Map([
  ["SKILL.md", encode("---\nname: demo-skill\ndescription: Demo.\n---\n")],
  ["references/api.md", encode("api")],
]);

function setup(overrides: Partial<InstallOptions> = {}) {
  const home = tempDir();
  const cwd = tempDir();
  const agents = loadAgents({ home, cwd, env: {}, exists: () => false });
  const pick = (...ids: string[]) => ids.map((id) => agents.find((agent) => agent.id === id)!);
  const options: InstallOptions = { global: false, copy: false, home, cwd, ...overrides };
  return { home, cwd, pick, options };
}

describe("sanitizeName", () => {
  it.each([
    ["demo-skill", "demo-skill"],
    ["Demo Skill!", "demo-skill"],
    ["../../etc", "etc"],
    ["", "unnamed-skill"],
  ])("turns %j into %j", (input, output) => {
    expect(sanitizeName(input)).toBe(output);
  });
});

describe("installSkill", () => {
  it("writes the canonical copy once and links other agents to it relatively", async () => {
    const { cwd, pick, options } = setup();
    const result = await installSkill("demo-skill", files, pick("claude-code", "cursor"), options);
    expect(result.canonicalPath).toBe(join(cwd, ".agents/skills/demo-skill"));
    expect(readFileSync(join(cwd, ".agents/skills/demo-skill/references/api.md"), "utf8")).toBe("api");
    expect(readlinkSync(join(cwd, ".claude/skills/demo-skill"))).toBe("../../.agents/skills/demo-skill");
    expect(readFileSync(join(cwd, ".claude/skills/demo-skill/SKILL.md"), "utf8")).toContain("name: demo-skill");
    expect(result.agents.map((agent) => [agent.agent.id, agent.status])).toEqual([
      ["claude-code", "symlinked"],
      ["cursor", "canonical"],
    ]);
  });

  it("installs under the home directory when global", async () => {
    const { home, pick, options } = setup({ global: true });
    await installSkill("demo-skill", files, pick("claude-code"), options);
    expect(existsSync(join(home, ".agents/skills/demo-skill/SKILL.md"))).toBe(true);
    expect(lstatSync(join(home, ".claude/skills/demo-skill")).isSymbolicLink()).toBe(true);
  });

  it("replaces whatever was installed before", async () => {
    const { cwd, pick, options } = setup();
    mkdirSync(join(cwd, ".agents/skills/demo-skill"), { recursive: true });
    writeFileSync(join(cwd, ".agents/skills/demo-skill/stale.md"), "stale");
    mkdirSync(join(cwd, ".claude/skills/demo-skill"), { recursive: true });
    await installSkill("demo-skill", files, pick("claude-code"), options);
    expect(existsSync(join(cwd, ".agents/skills/demo-skill/stale.md"))).toBe(false);
    expect(lstatSync(join(cwd, ".claude/skills/demo-skill")).isSymbolicLink()).toBe(true);
  });

  it("leaves a shared directory alone when the agent's directory already is the canonical one", async () => {
    const { cwd, pick, options } = setup();
    mkdirSync(join(cwd, ".agents/skills"), { recursive: true });
    mkdirSync(join(cwd, ".claude"));
    symlinkSync(join(cwd, ".agents/skills"), join(cwd, ".claude/skills"));
    const result = await installSkill("demo-skill", files, pick("claude-code"), options);
    expect(readFileSync(join(cwd, ".agents/skills/demo-skill/SKILL.md"), "utf8")).toContain("demo-skill");
    expect(lstatSync(join(cwd, ".agents/skills/demo-skill")).isDirectory()).toBe(true);
    expect(result.agents[0].status).toBe("symlinked");
  });

  it("copies into each distinct directory with copy", async () => {
    const { cwd, pick, options } = setup({ copy: true });
    const result = await installSkill("demo-skill", files, pick("claude-code", "cursor", "codex"), options);
    expect(lstatSync(join(cwd, ".claude/skills/demo-skill")).isDirectory()).toBe(true);
    expect(lstatSync(join(cwd, ".agents/skills/demo-skill")).isDirectory()).toBe(true);
    expect(result.agents.every((agent) => agent.status === "copied")).toBe(true);
  });

  it("falls back to a copy when the symlink cannot be created", async () => {
    const { cwd, pick, options } = setup();
    vi.mocked(symlink).mockRejectedValueOnce(Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }));
    const result = await installSkill("demo-skill", files, pick("claude-code"), options);
    expect(lstatSync(join(cwd, ".claude/skills/demo-skill")).isDirectory()).toBe(true);
    expect(result.agents[0]).toMatchObject({ status: "copied", symlinkFailed: true });
  });

  it("reports an agent that cannot install globally", async () => {
    const { pick, options } = setup({ global: true });
    const result = await installSkill("demo-skill", files, pick("eve"), options);
    expect(result.agents[0]).toMatchObject({ status: "failed", error: "Eve does not support global skill installation" });
  });

  it("reports a write failure instead of throwing", async () => {
    const { cwd, pick, options } = setup();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude/skills"), "not a directory");
    const result = await installSkill("demo-skill", files, pick("claude-code"), options);
    expect(result.agents[0].status).toBe("failed");
  });
});

describe("agentSkillDir", () => {
  it("keeps a hostile name inside the agent directory", () => {
    const { cwd, pick, options } = setup();
    expect(agentSkillDir(pick("claude-code")[0], "../../evil", options)).toBe(join(cwd, ".claude/skills/evil"));
  });
});

describe("existingTargets", () => {
  it("lists the agents whose install directory already exists", async () => {
    const { cwd, pick, options } = setup();
    mkdirSync(join(cwd, ".claude/skills/demo-skill"), { recursive: true });
    const found = await existingTargets("demo-skill", pick("claude-code", "windsurf"), options);
    expect(found.map((agent) => agent.id)).toEqual(["claude-code"]);
  });
});
