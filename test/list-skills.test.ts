import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgents, type AgentEnvironment } from "../src/agents.js";
import { installSkill, type InstallOptions } from "../src/installer.js";
import { findInstalledSkills, listedScopes, type InstalledSkill, type ListOptions, type ListScope } from "../src/list-skills.js";
import { cleanup, sandboxExists, tempDir } from "./helpers/fs.js";

afterEach(cleanup);

const encode = (text: string) => new TextEncoder().encode(text);

function skillMd(name: string, description = "Demo."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

function skillFiles(name: string): Map<string, Uint8Array> {
  return new Map([["SKILL.md", encode(skillMd(name))]]);
}

function writeSkillMd(dir: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
}

function setup() {
  const root = tempDir();
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home);
  mkdirSync(cwd);
  const exists = sandboxExists(root);
  const environment = (overrides: Partial<AgentEnvironment> = {}): AgentEnvironment => ({ home, cwd, env: {}, exists, ...overrides });
  const agents = loadAgents({ home, cwd, env: {}, exists: () => false });
  const pick = (...ids: string[]) => ids.map((id) => agents.find((agent) => agent.id === id)!);
  const install = (name: string, ids: string[], overrides: Partial<InstallOptions> = {}) =>
    installSkill(name, skillFiles(name), pick(...ids), { global: false, copy: false, confirmed: true, home, cwd, ...overrides });
  return { root, home, cwd, exists, environment, pick, install };
}

const listOptions = (overrides: Partial<ListOptions> = {}): ListOptions => ({ global: false, project: false, agents: null, json: false, ...overrides });

const simplify = (skills: InstalledSkill[]) =>
  skills.map((skill) => ({ name: skill.name, scope: skill.scope, path: skill.path, agents: skill.agents.map((agent) => agent.id) }));

describe("listedScopes", () => {
  it.each<[boolean, boolean, ListScope[]]>([
    [false, false, ["project", "global"]],
    [true, true, ["project", "global"]],
    [true, false, ["global"]],
    [false, true, ["project"]],
  ])("global=%s project=%s -> %j", (global, project, expected) => {
    expect(listedScopes(listOptions({ global, project }))).toEqual(expected);
  });
});

describe("findInstalledSkills", () => {
  it("returns nothing when nothing is installed", async () => {
    const { environment } = setup();
    expect(await findInstalledSkills(environment(), listOptions())).toEqual([]);
  });

  it("names the sole agent of its own directory even when the canonical directory names nobody", async () => {
    const { home, cwd, environment, install } = setup();
    mkdirSync(join(home, ".claude"));
    await install("demo-skill", ["claude-code"]);
    const result = await findInstalledSkills(environment(), listOptions());
    expect(simplify(result)).toEqual([{ name: "demo-skill", scope: "project", path: join(cwd, ".agents/skills/demo-skill"), agents: ["claude-code"] }]);
  });

  it("also names canonical agents detected on this machine, alongside claude-code", async () => {
    const { home, cwd, environment, install } = setup();
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(home, ".cursor"));
    await install("demo-skill", ["claude-code"]);
    const result = await findInstalledSkills(environment(), listOptions());
    expect(simplify(result)).toEqual([
      { name: "demo-skill", scope: "project", path: join(cwd, ".agents/skills/demo-skill"), agents: ["claude-code", "codex", "cursor"] },
    ]);
  });

  it("merges a --copy install's separate directories into one row", async () => {
    const { cwd, environment, install } = setup();
    await install("demo-skill", ["claude-code", "goose"], { copy: true });
    const result = await findInstalledSkills(environment(), listOptions());
    expect(simplify(result)).toEqual([
      { name: "demo-skill", scope: "project", path: join(cwd, ".claude/skills/demo-skill"), agents: ["claude-code", "goose"] },
    ]);
  });

  it("lists a global install under the global scope", async () => {
    const { home, environment, install } = setup();
    await install("demo-skill", ["claude-code"], { global: true });
    const result = await findInstalledSkills(environment(), listOptions());
    expect(simplify(result)).toEqual([{ name: "demo-skill", scope: "global", path: join(home, ".agents/skills/demo-skill"), agents: ["claude-code"] }]);
  });

  it("finds a skill in CLAUDE_CONFIG_DIR's skills directory for claude-code", async () => {
    const { root, environment } = setup();
    const configDir = join(root, "config");
    writeSkillMd(join(configDir, "skills/demo-skill"), skillMd("demo-skill"));
    const result = await findInstalledSkills(environment({ env: { CLAUDE_CONFIG_DIR: configDir } }), listOptions());
    expect(simplify(result)).toEqual([{ name: "demo-skill", scope: "global", path: join(configDir, "skills/demo-skill"), agents: ["claude-code"] }]);
  });

  it("limits to one scope with -g or -p, and allows both explicitly", async () => {
    const { home, cwd, environment, install } = setup();
    await install("proj-skill", ["claude-code"]);
    await install("glob-skill", ["claude-code"], { global: true });
    expect(simplify(await findInstalledSkills(environment(), listOptions({ project: true })))).toEqual([
      { name: "proj-skill", scope: "project", path: join(cwd, ".agents/skills/proj-skill"), agents: ["claude-code"] },
    ]);
    expect(simplify(await findInstalledSkills(environment(), listOptions({ global: true })))).toEqual([
      { name: "glob-skill", scope: "global", path: join(home, ".agents/skills/glob-skill"), agents: ["claude-code"] },
    ]);
    const both = simplify(await findInstalledSkills(environment(), listOptions({ project: true, global: true })));
    expect(both.map((skill) => skill.name)).toEqual(["proj-skill", "glob-skill"]);
  });

  it("lists a shared cwd/home directory once, as global, unless -p is given", async () => {
    const root = tempDir();
    const home = join(root, "shared");
    mkdirSync(home);
    const cwd = home;
    const exists = sandboxExists(root);
    writeSkillMd(join(home, ".agents/skills/demo-skill"), skillMd("demo-skill"));
    const environment: AgentEnvironment = { home, cwd, env: {}, exists };
    expect(simplify(await findInstalledSkills(environment, listOptions()))).toEqual([
      { name: "demo-skill", scope: "global", path: join(home, ".agents/skills/demo-skill"), agents: [] },
    ]);
    expect(simplify(await findInstalledSkills(environment, listOptions({ project: true })))).toEqual([
      { name: "demo-skill", scope: "project", path: join(cwd, ".agents/skills/demo-skill"), agents: [] },
    ]);
  });

  it("filters directories by the given agents, keeps '*' as no filter, and rejects unknown ids", async () => {
    const { cwd, environment, install } = setup();
    writeSkillMd(join(cwd, ".agents/skills/only-canonical"), skillMd("only-canonical"));
    await install("linked-skill", ["claude-code"]);

    const claudeOnly = simplify(await findInstalledSkills(environment(), listOptions({ agents: ["claude-code"] })));
    expect(claudeOnly.find((skill) => skill.name === "only-canonical")).toBeUndefined();
    expect(claudeOnly.find((skill) => skill.name === "linked-skill")).toEqual({
      name: "linked-skill",
      scope: "project",
      path: join(cwd, ".claude/skills/linked-skill"),
      agents: ["claude-code"],
    });

    const cursorOnly = simplify(await findInstalledSkills(environment(), listOptions({ agents: ["cursor"] })));
    expect(cursorOnly.find((skill) => skill.name === "only-canonical")).toEqual({
      name: "only-canonical",
      scope: "project",
      path: join(cwd, ".agents/skills/only-canonical"),
      agents: ["cursor"],
    });

    const unfiltered = simplify(await findInstalledSkills(environment(), listOptions({ agents: ["*"] })));
    expect(unfiltered.map((skill) => skill.name).sort()).toEqual(["linked-skill", "only-canonical"]);

    await expect(findInstalledSkills(environment(), listOptions({ agents: ["nope"] }))).rejects.toThrow(
      /^Invalid agents: nope\. Valid agents: aider-desk, amp,/,
    );
  });

  it("skips anything that is not a valid skill without crashing", async () => {
    const { cwd, environment } = setup();
    const canonicalDir = join(cwd, ".agents/skills");
    mkdirSync(join(canonicalDir, "no-skill-md"), { recursive: true });
    writeSkillMd(join(canonicalDir, "no-description"), "---\nname: x\n---\n");
    writeSkillMd(join(canonicalDir, "bad-yaml"), "---\nname: x\ndescription: [oops\n---\n");
    writeFileSync(join(canonicalDir, "plain-file"), "not a skill");
    symlinkSync(join(canonicalDir, "does-not-exist"), join(canonicalDir, "broken-link"));
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude/skills"), "not a directory");
    const result = await findInstalledSkills(environment(), listOptions());
    expect(result).toEqual([]);
  });

  it("names only detected Trae variants for a shared .trae/skills directory", async () => {
    const { home, cwd, environment } = setup();
    writeSkillMd(join(cwd, ".trae/skills/demo-skill"), skillMd("demo-skill"));
    const before = simplify(await findInstalledSkills(environment(), listOptions()));
    expect(before).toEqual([{ name: "demo-skill", scope: "project", path: join(cwd, ".trae/skills/demo-skill"), agents: [] }]);
    mkdirSync(join(home, ".trae-cn"));
    const after = simplify(await findInstalledSkills(environment(), listOptions()));
    expect(after).toEqual([{ name: "demo-skill", scope: "project", path: join(cwd, ".trae/skills/demo-skill"), agents: ["trae-cn"] }]);
  });

  it("detects Eve's own directory and names it", async () => {
    const { cwd, environment } = setup();
    mkdirSync(join(cwd, "agent"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ dependencies: { eve: "1" } }));
    writeSkillMd(join(cwd, "agent/skills/demo-skill"), skillMd("demo-skill"));
    const result = simplify(await findInstalledSkills(environment(), listOptions()));
    expect(result).toEqual([{ name: "demo-skill", scope: "project", path: join(cwd, "agent/skills/demo-skill"), agents: ["eve"] }]);
  });

  it("names a skill by its frontmatter and merges directories sharing that name", async () => {
    const { home, cwd, environment } = setup();
    mkdirSync(join(home, ".cursor"));
    mkdirSync(join(home, ".claude"));
    writeSkillMd(join(cwd, ".agents/skills/odd-dir"), skillMd("real-name"));
    writeSkillMd(join(cwd, ".claude/skills/real-name"), skillMd("real-name"));
    const result = simplify(await findInstalledSkills(environment(), listOptions()));
    expect(result).toEqual([{ name: "real-name", scope: "project", path: join(cwd, ".agents/skills/odd-dir"), agents: ["claude-code", "cursor"] }]);
  });
});
