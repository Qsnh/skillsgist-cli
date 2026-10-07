import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgents } from "../src/agents.js";
import { agentSkillDir, installSkill, outsideDirs, replacedDirs, sanitizeName, type InstallOptions } from "../src/installer.js";
import { cleanup, tempDir } from "./helpers/fs.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, symlink: vi.fn(actual.symlink), writeFile: vi.fn(actual.writeFile) };
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
  const options: InstallOptions = { global: false, copy: false, confirmed: false, home, cwd, ...overrides };
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
    expect(result.agents[0].status).toBe("copied");
  });

  it("reports an agent that cannot install globally", async () => {
    const { pick, options } = setup({ global: true });
    const result = await installSkill("demo-skill", files, pick("promptscript"), options);
    expect(result.agents[0]).toMatchObject({ status: "failed", error: "PromptScript does not support global skill installation" });
  });

  it("reports a write failure instead of throwing", async () => {
    const { cwd, pick, options } = setup();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude/skills"), "not a directory");
    const result = await installSkill("demo-skill", files, pick("claude-code"), options);
    expect(result.agents[0].status).toBe("failed");
  });

  it.each([false, true])("reports a failure with an empty message as a failure (copy: %s)", async (copy) => {
    const { pick, options } = setup({ copy });
    if (!copy) vi.mocked(symlink).mockRejectedValueOnce(new Error("EPERM"));
    vi.mocked(writeFile).mockImplementation(async (path) => {
      if (String(path).includes(".claude")) throw new Error("");
    });
    try {
      const result = await installSkill("demo-skill", files, pick("claude-code"), options);
      expect(result.agents[0]).toMatchObject({ status: "failed", error: "Error" });
    } finally {
      vi.mocked(writeFile).mockReset();
    }
  });

  it("leaves a project's own skills/ directory alone without confirmation", async () => {
    const { cwd, pick, options } = setup();
    mkdirSync(join(cwd, "skills/demo-skill"), { recursive: true });
    writeFileSync(join(cwd, "skills/demo-skill/SKILL.md"), "mine");
    const result = await installSkill("demo-skill", files, pick("openclaw", "claude-code"), options);
    expect(readFileSync(join(cwd, "skills/demo-skill/SKILL.md"), "utf8")).toBe("mine");
    expect(result.agents[0]).toMatchObject({ status: "failed", error: expect.stringContaining("skills/demo-skill already exists and is not a link") });
    expect(result.agents[1].status).toBe("symlinked");
  });

  it("replaces a project's own skills/ directory once the summary is confirmed, and an earlier link without it", async () => {
    const { cwd, pick, options } = setup();
    mkdirSync(join(cwd, "skills/demo-skill"), { recursive: true });
    await installSkill("demo-skill", files, pick("openclaw"), { ...options, confirmed: true });
    expect(lstatSync(join(cwd, "skills/demo-skill")).isSymbolicLink()).toBe(true);
    const again = await installSkill("demo-skill", files, pick("openclaw"), options);
    expect(again.agents[0].status).toBe("symlinked");
  });

  it("does not write through a link that leads out of the project without confirmation", async () => {
    const { cwd, pick, options } = setup();
    const outside = tempDir();
    mkdirSync(join(outside, "demo-skill"));
    writeFileSync(join(outside, "demo-skill/keep.md"), "keep");
    mkdirSync(join(cwd, ".agents"));
    symlinkSync(outside, join(cwd, ".agents/skills"));
    const result = await installSkill("demo-skill", files, pick("claude-code"), options);
    expect(result.agents[0]).toMatchObject({ status: "failed", error: expect.stringContaining(`leads out of the project to ${join(outside, "demo-skill")}`) });
    expect(readFileSync(join(outside, "demo-skill/keep.md"), "utf8")).toBe("keep");
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
    await installSkill("demo-skill", files, pick("claude-code"), { ...options, confirmed: true });
    expect(existsSync(join(outside, "demo-skill/SKILL.md"))).toBe(true);
  });
});

describe("agentSkillDir", () => {
  it("keeps a hostile name inside the agent directory", () => {
    const { cwd, pick, options } = setup();
    expect(agentSkillDir(pick("claude-code")[0], "../../evil", options)).toBe(join(cwd, ".claude/skills/evil"));
  });
});

describe("replacedDirs", () => {
  it("lists the canonical directory once and each agent directory that holds something else", async () => {
    const { cwd, pick, options } = setup();
    mkdirSync(join(cwd, ".agents/skills/demo-skill"), { recursive: true });
    mkdirSync(join(cwd, ".claude/skills/demo-skill"), { recursive: true });
    const found = await replacedDirs("demo-skill", pick("claude-code", "windsurf", "cursor", "codex", "dexto"), options);
    expect(found).toEqual([join(cwd, ".agents/skills/demo-skill"), join(cwd, ".claude/skills/demo-skill")]);
  });

  it("leaves out links that already point at the canonical copy", async () => {
    const { cwd, pick, options } = setup();
    await installSkill("demo-skill", files, pick("claude-code", "cursor"), options);
    expect(await replacedDirs("demo-skill", pick("claude-code", "cursor"), options)).toEqual([join(cwd, ".agents/skills/demo-skill")]);
  });

  it("counts a link that points somewhere else", async () => {
    const { cwd, pick, options } = setup();
    mkdirSync(join(cwd, "elsewhere"));
    mkdirSync(join(cwd, ".claude/skills"), { recursive: true });
    symlinkSync(join(cwd, "elsewhere"), join(cwd, ".claude/skills/demo-skill"));
    expect(await replacedDirs("demo-skill", pick("claude-code"), options)).toEqual([join(cwd, ".claude/skills/demo-skill")]);
  });

  it("leaves out what an unconfirmed install will not replace", async () => {
    const { cwd, pick, options } = setup();
    mkdirSync(join(cwd, "skills/demo-skill"), { recursive: true });
    expect(await replacedDirs("demo-skill", pick("openclaw"), options)).toEqual([]);
    expect(await replacedDirs("demo-skill", pick("openclaw"), { ...options, confirmed: true })).toEqual([join(cwd, "skills/demo-skill")]);
  });

  it("lists each existing target directory once with copy", async () => {
    const { cwd, pick, options } = setup({ copy: true });
    mkdirSync(join(cwd, ".agents/skills/demo-skill"), { recursive: true });
    expect(await replacedDirs("demo-skill", pick("claude-code", "cursor", "codex"), options)).toEqual([join(cwd, ".agents/skills/demo-skill")]);
  });
});

describe("outsideDirs", () => {
  it("names the project directories that lead out of the project and where they go", async () => {
    const { cwd, pick, options } = setup();
    const outside = tempDir();
    mkdirSync(join(cwd, ".claude"));
    symlinkSync(outside, join(cwd, ".claude/skills"));
    expect(await outsideDirs("demo-skill", pick("claude-code", "cursor"), options)).toEqual([
      [join(cwd, ".claude/skills/demo-skill"), join(outside, "demo-skill")],
    ]);
    expect(await outsideDirs("demo-skill", pick("claude-code"), { ...options, global: true })).toEqual([]);
  });

  it("keeps a project at the filesystem root inside itself", async () => {
    const { pick, options } = setup();
    expect(await outsideDirs("demo-skill", pick("claude-code", "cursor"), { ...options, cwd: "/" })).toEqual([]);
  });
});
