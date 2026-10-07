import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgents, type AgentEnvironment } from "../src/agents.js";
import { displayWidth } from "../src/format.js";
import { installSkill, type InstallOptions } from "../src/installer.js";
import {
  findInstalledSkills,
  formatInstalledSkills,
  listedScopes,
  listSkills,
  type InstalledSkill,
  type Listing,
  type ListOptions,
  type ListScope,
} from "../src/list-skills.js";
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

const nothing: Listing = { skills: [], problems: [] };

const simplify = ({ skills }: Listing) =>
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
    expect(await findInstalledSkills(environment(), listOptions())).toEqual(nothing);
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

  it("lists each copy of a --copy install on its own row", async () => {
    const { cwd, environment, install } = setup();
    await install("demo-skill", ["claude-code", "goose"], { copy: true });
    const result = await findInstalledSkills(environment(), listOptions());
    expect(simplify(result)).toEqual([
      { name: "demo-skill", scope: "project", path: join(cwd, ".claude/skills/demo-skill"), agents: ["claude-code"] },
      { name: "demo-skill", scope: "project", path: join(cwd, ".goose/skills/demo-skill"), agents: ["goose"] },
    ]);
  });

  it("merges a link into the folder it points to, even when the link sorts first", async () => {
    const { cwd, environment } = setup();
    writeSkillMd(join(cwd, ".goose/skills/demo-skill"), skillMd("demo-skill"));
    mkdirSync(join(cwd, ".claude/skills"), { recursive: true });
    symlinkSync(join(cwd, ".goose/skills/demo-skill"), join(cwd, ".claude/skills/demo-skill"));
    const result = await findInstalledSkills(environment(), listOptions());
    expect(simplify(result)).toEqual([
      { name: "demo-skill", scope: "project", path: join(cwd, ".goose/skills/demo-skill"), agents: ["claude-code", "goose"] },
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

  it("lists a shared cwd/home directory once, as global, when filtered to a single agent", async () => {
    const root = tempDir();
    const home = join(root, "shared");
    mkdirSync(home);
    const cwd = home;
    const exists = sandboxExists(root);
    mkdirSync(join(home, ".claude"));
    writeSkillMd(join(home, ".claude/skills/demo-skill"), skillMd("demo-skill"));
    const environment: AgentEnvironment = { home, cwd, env: {}, exists };
    const result = simplify(await findInstalledSkills(environment, listOptions({ agents: ["claude-code"] })));
    expect(result).toEqual([{ name: "demo-skill", scope: "global", path: join(home, ".claude/skills/demo-skill"), agents: ["claude-code"] }]);
  });

  it("lists a skill once, as global, when home is a symlink to cwd's realpath", async () => {
    const root = tempDir();
    const realHome = join(root, "real-home");
    mkdirSync(realHome);
    const homeLink = join(root, "home-link");
    symlinkSync(realHome, homeLink);
    const exists = sandboxExists(root);
    writeSkillMd(join(realHome, ".agents/skills/demo-skill"), skillMd("demo-skill"));
    const environment: AgentEnvironment = { home: homeLink, cwd: realHome, env: {}, exists };
    const result = simplify(await findInstalledSkills(environment, listOptions()));
    expect(result).toEqual([{ name: "demo-skill", scope: "global", path: join(homeLink, ".agents/skills/demo-skill"), agents: [] }]);
  });

  it("filters directories by the given agents, lists every directory for '*', and rejects unknown ids", async () => {
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
    await expect(findInstalledSkills(environment(), listOptions({ agents: ["*", "claud-code"] }))).rejects.toThrow(/^Invalid agents: claud-code\./);
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
    expect(result).toEqual(nothing);
  });

  it.skipIf(process.platform === "win32")("skips a FIFO named SKILL.md without hanging", async () => {
    const { cwd, environment } = setup();
    const dir = join(cwd, ".agents/skills/fifo-skill");
    mkdirSync(dir, { recursive: true });
    execFileSync("mkfifo", [join(dir, "SKILL.md")]);
    const result = await findInstalledSkills(environment(), listOptions());
    expect(result).toEqual(nothing);
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

  it("does not list a project-owned agent's directory when that agent is undetected", async () => {
    const { cwd, environment } = setup();
    writeSkillMd(join(cwd, "skills/demo-skill"), skillMd("demo-skill"));
    const result = await findInstalledSkills(environment(), listOptions());
    expect(result).toEqual(nothing);
  });

  it("does not take a project's own skills/ folders for OpenClaw's because ~/.openclaw exists", async () => {
    const { home, cwd, environment } = setup();
    writeSkillMd(join(cwd, "skills/authored-skill"), skillMd("authored-skill"));
    mkdirSync(join(home, ".openclaw"));
    expect(await findInstalledSkills(environment(), listOptions())).toEqual(nothing);
  });

  it("names OpenClaw for the links add put in a project's skills/ folder, and not for the project's own folders", async () => {
    const { cwd, environment, install } = setup();
    writeSkillMd(join(cwd, "skills/authored-skill"), skillMd("authored-skill"));
    await install("demo-skill", ["openclaw"]);
    const result = simplify(await findInstalledSkills(environment(), listOptions()));
    expect(result).toEqual([{ name: "demo-skill", scope: "project", path: join(cwd, ".agents/skills/demo-skill"), agents: ["openclaw"] }]);
  });

  it("lists a project-owned agent's global directory once that agent is detected", async () => {
    const { home, environment } = setup();
    writeSkillMd(join(home, ".openclaw/skills/demo-skill"), skillMd("demo-skill"));
    const result = simplify(await findInstalledSkills(environment(), listOptions()));
    expect(result).toEqual([{ name: "demo-skill", scope: "global", path: join(home, ".openclaw/skills/demo-skill"), agents: ["openclaw"] }]);
  });

  it("lists an undetected project-owned agent's directory when named with -a", async () => {
    const { cwd, environment } = setup();
    writeSkillMd(join(cwd, "skills/demo-skill"), skillMd("demo-skill"));
    const result = simplify(await findInstalledSkills(environment(), listOptions({ agents: ["openclaw"] })));
    expect(result).toEqual([{ name: "demo-skill", scope: "project", path: join(cwd, "skills/demo-skill"), agents: ["openclaw"] }]);
  });

  it("lists an undetected project-owned agent's directory with -a '*', as add -a '*' writes there", async () => {
    const { cwd, environment, install } = setup();
    await install("demo-skill", ["openclaw"], { copy: true });
    const result = simplify(await findInstalledSkills(environment(), listOptions({ agents: ["*"] })));
    expect(result).toEqual([{ name: "demo-skill", scope: "project", path: join(cwd, "skills/demo-skill"), agents: ["openclaw"] }]);
  });

  it("takes a project's data/skills folder as AstrBot's only when the project itself is an AstrBot one", async () => {
    const { home, cwd, environment } = setup();
    writeSkillMd(join(cwd, "data/skills/demo-skill"), skillMd("demo-skill"));
    expect(await findInstalledSkills(environment(), listOptions())).toEqual(nothing);
    mkdirSync(join(home, ".astrbot"));
    expect(await findInstalledSkills(environment(), listOptions())).toEqual(nothing);
    writeFileSync(join(cwd, "data/cmd_config.json"), "{}");
    const result = simplify(await findInstalledSkills(environment(), listOptions()));
    expect(result).toEqual([{ name: "demo-skill", scope: "project", path: join(cwd, "data/skills/demo-skill"), agents: ["astrbot"] }]);
  });

  it("skips a SKILL.md with no name", async () => {
    const { cwd, environment } = setup();
    writeSkillMd(join(cwd, ".agents/skills/no-name"), "---\ndescription: Demo.\n---\n");
    const result = await findInstalledSkills(environment(), listOptions());
    expect(result).toEqual(nothing);
  });

  it("names a skill by its frontmatter and keeps separate folders sharing that name apart", async () => {
    const { home, cwd, environment } = setup();
    mkdirSync(join(home, ".cursor"));
    mkdirSync(join(home, ".claude"));
    writeSkillMd(join(cwd, ".agents/skills/odd-dir"), skillMd("real-name"));
    writeSkillMd(join(cwd, ".claude/skills/real-name"), skillMd("real-name", "An older copy."));
    const result = simplify(await findInstalledSkills(environment(), listOptions()));
    expect(result).toEqual([
      { name: "real-name", scope: "project", path: join(cwd, ".agents/skills/odd-dir"), agents: ["cursor"] },
      { name: "real-name", scope: "project", path: join(cwd, ".claude/skills/real-name"), agents: ["claude-code"] },
    ]);
  });

  it("reads the frontmatter of a SKILL.md with a large body", async () => {
    const { cwd, environment } = setup();
    writeSkillMd(join(cwd, ".agents/skills/big"), `${skillMd("big")}
${"x".repeat(1024 * 1024)}
`);
    const result = simplify(await findInstalledSkills(environment(), listOptions()));
    expect(result.map((skill) => skill.name)).toEqual(["big"]);
  });

  it("records the canonical folder and its link to it as separate entries", async () => {
    const { home, cwd, environment, install } = setup();
    mkdirSync(join(home, ".claude"));
    await install("demo-skill", ["claude-code"]);
    const result = await findInstalledSkills(environment(), listOptions());
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].entries).toEqual([
      { path: join(cwd, ".agents/skills/demo-skill"), linked: false },
      { path: join(cwd, ".claude/skills/demo-skill"), linked: true },
    ]);
  });

  it("gives each --copy row its own single real entry", async () => {
    const { cwd, environment, install } = setup();
    await install("demo-skill", ["claude-code", "goose"], { copy: true });
    const result = await findInstalledSkills(environment(), listOptions());
    expect(result.skills.map((skill) => skill.entries)).toEqual([
      [{ path: join(cwd, ".claude/skills/demo-skill"), linked: false }],
      [{ path: join(cwd, ".goose/skills/demo-skill"), linked: false }],
    ]);
  });

  it("gives a link to a folder outside every skills directory its own single entry", async () => {
    const { root, cwd, environment } = setup();
    writeSkillMd(join(root, "elsewhere/demo-skill"), skillMd("demo-skill"));
    mkdirSync(join(cwd, ".claude/skills"), { recursive: true });
    const link = join(cwd, ".claude/skills/demo-skill");
    symlinkSync(join(root, "elsewhere/demo-skill"), link);
    const result = await findInstalledSkills(environment(), listOptions());
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].entries).toEqual([{ path: link, linked: true }]);
  });

  it("keeps an undetected OpenClaw's link in the canonical row's entries, and leaves the project's own folder out of every row", async () => {
    const { cwd, environment, install } = setup();
    writeSkillMd(join(cwd, "skills/own"), skillMd("own"));
    await install("demo-skill", ["openclaw"]);
    const result = await findInstalledSkills(environment(), listOptions());
    expect(result.skills.some((skill) => skill.name === "own")).toBe(false);
    const row = result.skills.find((skill) => skill.name === "demo-skill")!;
    expect(row.path).toBe(join(cwd, ".agents/skills/demo-skill"));
    expect(row.entries).toEqual([
      { path: join(cwd, ".agents/skills/demo-skill"), linked: false },
      { path: join(cwd, "skills/demo-skill"), linked: true },
    ]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("lists what it can read and names the folders it cannot", async () => {
    const { cwd, environment } = setup();
    writeSkillMd(join(cwd, ".agents/skills/readable"), skillMd("readable"));
    writeSkillMd(join(cwd, ".agents/skills/locked"), skillMd("locked"));
    writeSkillMd(join(cwd, ".claude/skills/hidden"), skillMd("hidden"));
    chmodSync(join(cwd, ".agents/skills/locked"), 0o000);
    chmodSync(join(cwd, ".claude/skills"), 0o000);
    try {
      const result = await findInstalledSkills(environment(), listOptions({ project: true }));
      expect(result.skills.map((skill) => skill.name)).toEqual(["readable"]);
      expect(result.problems).toEqual(["Cannot read ./.agents/skills/locked/SKILL.md (EACCES)", "Cannot read ./.claude/skills (EACCES)"]);
    } finally {
      chmodSync(join(cwd, ".agents/skills/locked"), 0o755);
      chmodSync(join(cwd, ".claude/skills"), 0o755);
    }
  });
});

describe("formatInstalledSkills", () => {
  const place = { home: "/h", cwd: "/w" };
  const agentsOf = (...ids: string[]) => {
    const agents = loadAgents({ home: "/h", cwd: "/w", env: {}, exists: () => false });
    return ids.map((id) => agents.find((agent) => agent.id === id)!);
  };
  const skill = (name: string, scope: ListScope, path: string, ids: string[] = []): InstalledSkill => ({
    name,
    scope,
    path,
    agents: agentsOf(...ids),
    entries: [{ path, linked: false }],
  });

  it("says nothing is installed, per requested scope", () => {
    expect(formatInstalledSkills([], listOptions(), place)).toBe("No project skills\n\nNo global skills\n");
    expect(formatInstalledSkills([], listOptions({ global: true }), place)).toBe("No global skills\n");
    expect(formatInstalledSkills([], listOptions({ project: true }), place)).toBe("No project skills\n");
  });

  it("renders a table per scope, project first, aligned and without trailing spaces", () => {
    const skills = [
      skill("demo-skill", "project", "/w/.agents/skills/demo-skill", ["claude-code", "codex"]),
      skill("other", "project", "/w/.claude/skills/other", ["claude-code"]),
      skill("glob-skill", "global", "/h/.agents/skills/glob-skill", ["claude-code"]),
    ];
    const text = formatInstalledSkills(skills, listOptions(), place);
    const lines = text.split("\n");
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe("2 project skills");
    expect(lines[1]).toBe("");
    const projectHeader = lines[2];
    expect(projectHeader).toMatch(/^NAME +PATH +AGENTS$/);
    expect(lines[3].indexOf("./.agents/skills/demo-skill")).toBe(projectHeader.indexOf("PATH"));
    expect(lines[3].indexOf("Claude Code, Codex")).toBe(projectHeader.indexOf("AGENTS"));
    expect(lines[4]).toContain("./.claude/skills/other");
    expect(lines[5]).toBe("");
    expect(lines[6]).toBe("1 global skill");
    expect(lines[7]).toBe("");
    const globalHeader = lines[8];
    expect(globalHeader).toMatch(/^NAME +PATH +AGENTS$/);
    expect(lines[9].indexOf("~/.agents/skills/glob-skill")).toBe(globalHeader.indexOf("PATH"));
    expect(lines[10]).toBe("");
    expect(lines.filter((line) => line !== line.trimEnd())).toEqual([]);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("aligns the columns after a name with wide characters", () => {
    const skills = [skill("技能-demo", "project", "/w/.agents/skills/wide"), skill("narrow-skill-x", "project", "/w/.agents/skills/narrow")];
    const lines = formatInstalledSkills(skills, listOptions({ project: true }), place).split("\n");
    const column = displayWidth(lines[2].slice(0, lines[2].indexOf("PATH")));
    expect(displayWidth(lines[3].slice(0, lines[3].indexOf("./")))).toBe(column);
    expect(displayWidth(lines[4].slice(0, lines[4].indexOf("./")))).toBe(column);
  });

  it("renders project paths relative to cwd and global paths relative to, or outside, home", () => {
    const project = formatInstalledSkills([skill("a", "project", "/w/.agents/skills/a")], listOptions({ project: true }), place);
    expect(project).toContain("./.agents/skills/a");

    const globalHome = formatInstalledSkills([skill("a", "global", "/h/.agents/skills/a")], listOptions({ global: true }), place);
    expect(globalHome).toContain("~/.agents/skills/a");

    const globalOutside = formatInstalledSkills([skill("a", "global", "/x/goose/skills/a")], listOptions({ global: true }), place);
    expect(globalOutside).toContain("/x/goose/skills/a");
  });

  it("shows a dash for no agents and display names joined with a comma otherwise", () => {
    const none = formatInstalledSkills([skill("solo", "project", "/w/.agents/skills/solo", [])], listOptions({ project: true }), place);
    const row = none.split("\n").find((line) => line.startsWith("solo"))!;
    expect(row.trimEnd().endsWith("—")).toBe(true);

    const many = formatInstalledSkills(
      [skill("multi", "project", "/w/.agents/skills/multi", ["claude-code", "codex"])],
      listOptions({ project: true }),
      place,
    );
    expect(many).toContain("Claude Code, Codex");
  });

  it("prints JSON with absolute paths, agent ids, and project rows first", () => {
    const skills = [
      skill("demo-skill", "project", "/w/.agents/skills/demo-skill", ["claude-code", "codex"]),
      skill("glob-skill", "global", "/h/.agents/skills/glob-skill", ["claude-code"]),
    ];
    const text = formatInstalledSkills(skills, listOptions({ json: true }), place);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual([
      { name: "demo-skill", path: "/w/.agents/skills/demo-skill", scope: "project", agents: ["claude-code", "codex"] },
      { name: "glob-skill", path: "/h/.agents/skills/glob-skill", scope: "global", agents: ["claude-code"] },
    ]);
  });

  it("prints the real path in JSON, whatever characters it holds", () => {
    const path = "/w/odd\u202e\x1b/h.example/i/abcdefghijkl/.agents/skills/a";
    const json = formatInstalledSkills([skill("a", "project", path)], listOptions({ json: true }), place);
    expect(JSON.parse(json)[0].path).toBe(path);
  });

  it("prints an empty JSON array when nothing is installed", () => {
    expect(formatInstalledSkills([], listOptions({ json: true }), place)).toBe("[]\n");
  });

  it("keeps the JSON row's keys limited to name, path, scope, agents", () => {
    const skills = [skill("demo-skill", "project", "/w/.agents/skills/demo-skill", ["claude-code"])];
    const rows = JSON.parse(formatInstalledSkills(skills, listOptions({ json: true }), place));
    expect(Object.keys(rows[0]).sort()).toEqual(["agents", "name", "path", "scope"]);
  });

  it("strips terminal escapes and keeps a name with a newline on one text row", () => {
    const evil = skill("evil\x1b]52;c;ZXZpbA==\x07\nnext", "project", "/w/.agents/skills/evil", ["claude-code"]);
    const text = formatInstalledSkills([evil], listOptions({ project: true }), place);
    expect(text).not.toMatch(/[\x1b\x07]/);
    expect(text.split("\n")).toHaveLength(5);

    const json = formatInstalledSkills([evil], listOptions({ project: true, json: true }), place);
    expect(json).not.toMatch(/[\x1b\x07]/);
    expect(JSON.parse(json)[0].name).not.toMatch(/[\x1b\x07]/);
  });

  it("masks an install key embedded in a name, in text and JSON", () => {
    const leaky = skill("https://h.example/i/abcdefghijkl", "project", "/w/.agents/skills/leaky", []);
    const text = formatInstalledSkills([leaky], listOptions({ project: true }), place);
    expect(text).toContain("/i/abcd…");
    expect(text).not.toContain("abcdefghijkl");

    const json = formatInstalledSkills([leaky], listOptions({ project: true, json: true }), place);
    expect(json).toContain("/i/abcd…");
    expect(json).not.toContain("abcdefghijkl");
  });
});

describe("listSkills", () => {
  it("renders the installed skills as text, end to end", async () => {
    const { environment, install } = setup();
    await install("demo-skill", ["claude-code"]);
    const { output, problems } = await listSkills(environment(), listOptions());
    expect(output).toContain("1 project skill");
    expect(output).toContain("./.agents/skills/demo-skill");
    expect(output).toContain("Claude Code");
    expect(output).toContain("No global skills");
    expect(problems).toEqual([]);
  });
});
