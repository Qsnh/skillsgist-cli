import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANCELLED, type Ui } from "../src/add.js";
import { loadAgents, type AgentEnvironment } from "../src/agents.js";
import { CliError } from "../src/errors.js";
import { installSkill, type InstallOptions } from "../src/installer.js";
import { shortPath } from "../src/paths.js";
import { findRemovals, pickRemovals, runRemove, vetRemovals, type RemoveContext, type RemoveOptions } from "../src/remove.js";
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
  const context = (ui: Ui, env: NodeJS.ProcessEnv = {}, interactive = true): RemoveContext => ({ ui, home, cwd, env, interactive, exists });
  return { root, home, cwd, exists, environment, pick, install, context };
}

type Answer<T> = T | typeof CANCELLED;

interface Answers {
  selectInstalled?: Answer<number[]>;
  confirm?: Answer<boolean>;
}

function fakeUi(answers: Answers = {}) {
  const lines: string[] = [];
  const asked: string[] = [];
  function answer<T>(name: string): T {
    asked.push(name);
    if (!(name in answers)) throw new Error(`unexpected ${name} prompt`);
    return answers[name as keyof Answers] as T;
  }
  const ui: Ui = {
    intro: (message) => lines.push(message),
    step: (message) => lines.push(message),
    info: (message) => lines.push(message),
    warn: (message) => lines.push(`warn: ${message}`),
    error: (message) => lines.push(`error: ${message}`),
    message: (message) => lines.push(message),
    note: (body, title) => lines.push(`${title}\n${body}`),
    cancel: (message) => lines.push(`cancel: ${message}`),
    outro: (message) => lines.push(message),
    selectSkills: async () => answer("selectSkills"),
    selectAgents: async () => answer("selectAgents"),
    selectScope: async () => answer("selectScope"),
    selectInstalled: async (skills) => {
      lines.push(...skills.map((skill) => `${skill.name} ${skill.path}`));
      return answer("selectInstalled");
    },
    confirm: async (message) => {
      lines.push(message);
      return answer("confirm");
    },
  };
  return { ui, asked, text: () => lines.join("\n") };
}

const present = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

function left(base: string): { agents: string[]; claude: string[] } {
  const names = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
  return { agents: names(join(base, ".agents/skills")), claude: names(join(base, ".claude/skills")) };
}

async function failure(promise: Promise<unknown>): Promise<CliError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(CliError);
  return error as CliError;
}

const removeOptions = (overrides: Partial<RemoveOptions> = {}): RemoveOptions => ({
  global: false,
  agents: null,
  skills: [],
  all: false,
  yes: false,
  ...overrides,
});

describe("findRemovals", () => {
  it("scopes to project or global, and orders a link before the real folder", async () => {
    const { home, cwd, environment, install } = setup();
    mkdirSync(join(home, ".claude"));
    await install("demo-skill", ["claude-code"]);

    const project = await findRemovals(environment(), removeOptions());
    expect(project.removals).toEqual([
      {
        name: "demo-skill",
        path: join(cwd, ".agents/skills/demo-skill"),
        entries: [
          { path: join(cwd, ".claude/skills/demo-skill"), linked: true },
          { path: join(cwd, ".agents/skills/demo-skill"), linked: false },
        ],
        keptBy: [],
      },
    ]);
    expect(project.problems).toEqual([]);
    expect((await findRemovals(environment(), removeOptions({ global: true }))).removals).toEqual([]);

    await install("glob-skill", ["claude-code"], { global: true });
    expect((await findRemovals(environment(), removeOptions())).removals.map((removal) => removal.name)).toEqual(["demo-skill"]);
    expect((await findRemovals(environment(), removeOptions({ global: true }))).removals.map((removal) => removal.name)).toEqual(["glob-skill"]);
  });

  it("filters entries by -a, names which agents still keep the folder, and validates agent ids", async () => {
    const { home, cwd, environment, install } = setup();
    mkdirSync(join(home, ".claude"));
    await install("demo-skill", ["claude-code", "cursor"]);

    const claudeOnly = await findRemovals(environment(), removeOptions({ agents: ["claude-code"] }));
    expect(claudeOnly.removals).toEqual([
      {
        name: "demo-skill",
        path: join(cwd, ".agents/skills/demo-skill"),
        entries: [{ path: join(cwd, ".claude/skills/demo-skill"), linked: true }],
        keptBy: [],
      },
    ]);

    const cursorOnly = await findRemovals(environment(), removeOptions({ agents: ["cursor"] }));
    expect(cursorOnly.removals).toEqual([
      {
        name: "demo-skill",
        path: join(cwd, ".agents/skills/demo-skill"),
        entries: [{ path: join(cwd, ".agents/skills/demo-skill"), linked: false }],
        keptBy: [join(cwd, ".claude/skills/demo-skill")],
      },
    ]);

    const both = await findRemovals(environment(), removeOptions({ agents: ["claude-code", "cursor"] }));
    expect(both.removals).toEqual([
      {
        name: "demo-skill",
        path: join(cwd, ".agents/skills/demo-skill"),
        entries: [
          { path: join(cwd, ".claude/skills/demo-skill"), linked: true },
          { path: join(cwd, ".agents/skills/demo-skill"), linked: false },
        ],
        keptBy: [],
      },
    ]);

    expect((await findRemovals(environment(), removeOptions({ agents: ["goose"] }))).removals).toEqual([]);

    await expect(findRemovals(environment(), removeOptions({ agents: ["nope"] }))).rejects.toThrow(/^Invalid agents: nope\./);
  });
});

describe("pickRemovals", () => {
  it("matches a typed name against the skill's own name or any entry's folder name", async () => {
    const { cwd, environment, install } = setup();
    writeSkillMd(join(cwd, ".agents/skills/odd-dir"), skillMd("real-name"));
    await install("demo-skill", ["claude-code", "goose"], { copy: true });
    const { removals } = await findRemovals(environment(), removeOptions());

    const oddDir = removals.find((removal) => removal.name === "real-name")!;
    const copies = removals.filter((removal) => removal.name === "demo-skill");
    expect(copies).toHaveLength(2);

    for (const typed of ["demo-skill", "Demo-Skill", "demo skill"]) {
      expect(pickRemovals(removals, [typed]).picked).toEqual(copies);
    }
    expect(pickRemovals(removals, ["real-name"]).picked).toEqual([oddDir]);
    expect(pickRemovals(removals, ["odd-dir"]).picked).toEqual([oddDir]);
    expect(pickRemovals(removals, ["demo-skill", "nope", "nope"])).toEqual({ picked: copies, missing: ["nope"] });
  });
});

describe("vetRemovals", () => {
  it("refuses to delete a real folder still linked from agents left out of -a", async () => {
    const { home, cwd, environment, install } = setup();
    mkdirSync(join(home, ".claude"));
    await install("demo-skill", ["claude-code", "cursor"]);
    const { removals } = await findRemovals(environment(), removeOptions({ agents: ["cursor"] }));

    for (const yes of [false, true]) {
      const { refusals } = await vetRemovals(removals, environment(), { global: false, yes });
      expect(refusals).toEqual([
        `${shortPath(join(cwd, ".agents/skills/demo-skill"), home, cwd)} is still linked from ${shortPath(join(cwd, ".claude/skills/demo-skill"), home, cwd)}; add those agents to -a, or leave out -a`,
      ]);
    }
  });

  it("flags a link leading outside the project, refusing it only with -y, and never in the global scope", async () => {
    const { root, home, cwd, environment, install } = setup();
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(cwd, ".claude"));
    await install("demo-skill", ["claude-code"]);
    const { removals } = await findRemovals(environment(), removeOptions());

    const linkPath = join(cwd, ".claude/skills/demo-skill");
    const outsidePath = join(root, "elsewhere/skills/demo-skill");

    const quiet = await vetRemovals(removals, environment(), { global: false, yes: false });
    expect(quiet.outside).toEqual(new Map([[linkPath, outsidePath]]));
    expect(quiet.refusals).toEqual([]);

    const confirmed = await vetRemovals(removals, environment(), { global: false, yes: true });
    expect(confirmed.outside).toEqual(new Map([[linkPath, outsidePath]]));
    expect(confirmed.refusals).toEqual([
      `${shortPath(linkPath, home, cwd)} leads out of the project to ${outsidePath}; remove from a terminal without -y to confirm`,
    ]);

    const globalVet = await vetRemovals(removals, environment(), { global: true, yes: true });
    expect(globalVet.outside.size).toBe(0);
    expect(globalVet.refusals).toEqual([]);
  });

  it("keeps an undetected OpenClaw's link in its removal, and leaves the project's own folder out of every removal", async () => {
    const { cwd, environment, install } = setup();
    writeSkillMd(join(cwd, "skills/own"), skillMd("own"));
    await install("demo-skill", ["openclaw"]);
    const { removals } = await findRemovals(environment(), removeOptions());

    const demo = removals.find((removal) => removal.name === "demo-skill")!;
    expect(demo.entries.some((entry) => entry.path === join(cwd, "skills/demo-skill"))).toBe(true);
    expect(removals.some((removal) => removal.entries.some((entry) => entry.path === join(cwd, "skills/own")))).toBe(false);
    expect(pickRemovals(removals, ["own"]).missing).toEqual(["own"]);
  });

  it("refuses to delete AstrBot's own real folder with -y, but not a link into it", async () => {
    const { home, cwd, environment, install } = setup();
    mkdirSync(join(cwd, ".astrbot"));
    writeSkillMd(join(cwd, "data/skills/demo-skill"), skillMd("demo-skill"));
    await install("other", ["astrbot"]);
    const { removals } = await findRemovals(environment(), removeOptions());

    const demo = removals.find((removal) => removal.name === "demo-skill")!;
    const quiet = await vetRemovals([demo], environment(), { global: false, yes: false });
    expect(quiet.refusals).toEqual([]);

    const confirmed = await vetRemovals([demo], environment(), { global: false, yes: true });
    expect(confirmed.refusals).toEqual([
      `${shortPath(join(cwd, "data/skills/demo-skill"), home, cwd)} is not a link, and the project keeps its own skills there; remove from a terminal without -y to confirm`,
    ]);

    const other = removals.find((removal) => removal.name === "other")!;
    const otherVetted = await vetRemovals([other], environment(), { global: false, yes: true });
    expect(otherVetted.refusals).toEqual([]);
  });
});

describe("runRemove", () => {
  const both = { agents: ["demo-skill", "other-skill"], claude: ["demo-skill", "other-skill"] };

  async function installBoth(install: ReturnType<typeof setup>["install"]): Promise<void> {
    await install("demo-skill", ["claude-code"]);
    await install("other-skill", ["claude-code"]);
  }

  it("removes a named skill's link and folder without asking anything under -y", async () => {
    const { cwd, context, install } = setup();
    await installBoth(install);
    const ui = fakeUi();
    expect(await runRemove(removeOptions({ skills: ["demo-skill"], yes: true }), context(ui.ui))).toBe(0);
    expect(ui.asked).toEqual([]);
    expect(present(join(cwd, ".agents/skills/demo-skill"))).toBe(false);
    expect(present(join(cwd, ".claude/skills/demo-skill"))).toBe(false);
    expect(lstatSync(join(cwd, ".claude/skills/other-skill")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/other-skill/SKILL.md"))).toBe(true);
    expect(ui.text()).toContain("Removal Summary\ndemo-skill\n  ./.claude/skills/demo-skill (link)\n  ./.agents/skills/demo-skill");
    expect(ui.text()).toContain("Removed 1 skill\n✓ demo-skill");
    expect(ui.text()).not.toContain("other-skill");
    expect(ui.text()).toMatch(/Done!$/);
  });

  it("asks which skills to remove and confirms first without -y", async () => {
    const { cwd, context, install } = setup();
    await installBoth(install);

    const declined = fakeUi({ selectInstalled: [1], confirm: false });
    expect(await runRemove(removeOptions(), context(declined.ui))).toBe(0);
    expect(declined.text()).toContain("cancel: Removal cancelled");
    expect(left(cwd)).toEqual(both);

    const dismissed = fakeUi({ selectInstalled: CANCELLED });
    expect(await runRemove(removeOptions(), context(dismissed.ui))).toBe(0);
    expect(dismissed.asked).toEqual(["selectInstalled"]);
    expect(dismissed.text()).toContain("cancel: Removal cancelled");
    expect(left(cwd)).toEqual(both);

    const ui = fakeUi({ selectInstalled: [1], confirm: true });
    expect(await runRemove(removeOptions(), context(ui.ui))).toBe(0);
    expect(ui.asked).toEqual(["selectInstalled", "confirm"]);
    expect(ui.text()).toContain("demo-skill ./.agents/skills/demo-skill\nother-skill ./.agents/skills/other-skill");
    expect(ui.text()).toContain("Remove 1 skill?");
    expect(ui.text()).toContain("Removed 1 skill\n✓ other-skill");
    expect(left(cwd)).toEqual({ agents: ["demo-skill"], claude: ["demo-skill"] });
  });

  it("removes every project skill with --all and leaves the global ones", async () => {
    const { home, cwd, context, install } = setup();
    await installBoth(install);
    await install("glob-skill", ["claude-code"], { global: true });
    const ui = fakeUi();
    expect(await runRemove(removeOptions({ all: true, yes: true }), context(ui.ui))).toBe(0);
    expect(ui.asked).toEqual([]);
    expect(ui.text()).toContain("Removed 2 skills\n✓ demo-skill\n✓ other-skill");
    expect(left(cwd)).toEqual({ agents: [], claude: [] });
    expect(left(home)).toEqual({ agents: ["glob-skill"], claude: ["glob-skill"] });
  });

  it("says when there is nothing to remove", async () => {
    const { context } = setup();
    const project = fakeUi();
    expect(await runRemove(removeOptions(), context(project.ui))).toBe(0);
    expect(project.asked).toEqual([]);
    expect(project.text()).toContain("No project skills to remove");

    const global = fakeUi();
    expect(await runRemove(removeOptions({ global: true, all: true, yes: true }), context(global.ui))).toBe(0);
    expect(global.text()).toContain("No global skills to remove");
  });

  it("needs a terminal or -y, and inside an agent removes only named skills, without asking", async () => {
    const { cwd, context, install } = setup();
    await installBoth(install);

    const noTerminal = fakeUi();
    const error = await failure(runRemove(removeOptions({ skills: ["demo-skill"] }), context(noTerminal.ui, {}, false)));
    expect(error.message).toBe("There is no terminal to ask questions in. Add -y to remove without prompts.");
    expect(noTerminal.asked).toEqual([]);
    expect(left(cwd)).toEqual(both);

    const unnamed = fakeUi();
    const usage = await failure(runRemove(removeOptions(), context(unnamed.ui, { CLAUDECODE: "1" }, false)));
    expect(usage.message).toBe("Name the skills to remove, or use --all");
    expect(usage.showUsage).toBe(true);
    expect(unnamed.asked).toEqual([]);
    expect(left(cwd)).toEqual(both);

    const agent = fakeUi();
    expect(await runRemove(removeOptions({ skills: ["demo-skill"] }), context(agent.ui, { CLAUDECODE: "1" }, false))).toBe(0);
    expect(agent.asked).toEqual([]);
    expect(agent.text()).toContain("Claude Code detected — removing non-interactively");
    expect(left(cwd)).toEqual({ agents: ["other-skill"], claude: ["other-skill"] });
  });

  it("removes nothing when a named skill is not installed, and names the scope it is installed in", async () => {
    const { cwd, context, install } = setup();
    await installBoth(install);

    const local = await failure(runRemove(removeOptions({ skills: ["demo-skill", "nope"], yes: true }), context(fakeUi().ui)));
    expect(local.message).toBe("Not installed in the project: nope. Installed there: demo-skill, other-skill");
    expect(left(cwd)).toEqual(both);

    await install("nope", ["claude-code"], { global: true });
    const elsewhere = await failure(runRemove(removeOptions({ skills: ["demo-skill", "nope"], yes: true }), context(fakeUi().ui)));
    expect(elsewhere.message).toBe("Not installed in the project: nope. Installed there: demo-skill, other-skill\nInstalled globally: nope (add -g)");
    expect(left(cwd)).toEqual(both);

    const global = await failure(runRemove(removeOptions({ global: true, skills: ["demo-skill"], yes: true }), context(fakeUi().ui)));
    expect(global.message).toBe("Not installed globally: demo-skill. Installed there: nope\nInstalled in the project: demo-skill (leave out -g)");
  });

  it("deletes a link to a folder outside every skills directory, but not the folder", async () => {
    const { root, cwd, context } = setup();
    writeSkillMd(join(root, "elsewhere/demo-skill"), skillMd("demo-skill"));
    mkdirSync(join(cwd, ".claude/skills"), { recursive: true });
    symlinkSync(join(root, "elsewhere/demo-skill"), join(cwd, ".claude/skills/demo-skill"));
    const ui = fakeUi();
    expect(await runRemove(removeOptions({ skills: ["demo-skill"], yes: true }), context(ui.ui))).toBe(0);
    expect(present(join(cwd, ".claude/skills/demo-skill"))).toBe(false);
    expect(existsSync(join(root, "elsewhere/demo-skill/SKILL.md"))).toBe(true);
  });

  it("refuses a skills directory leading out of the project under -y, and removes it once confirmed", async () => {
    const { root, cwd, context, install } = setup();
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(cwd, ".claude"));
    await install("demo-skill", ["claude-code"]);
    const outsideLink = join(root, "elsewhere/skills/demo-skill");

    const refused = await failure(runRemove(removeOptions({ skills: ["demo-skill"], yes: true }), context(fakeUi().ui)));
    expect(refused.message).toMatch(/^Nothing was removed:\n/);
    expect(present(join(cwd, ".agents/skills/demo-skill"))).toBe(true);
    expect(present(outsideLink)).toBe(true);

    const ui = fakeUi({ confirm: true });
    expect(await runRemove(removeOptions({ skills: ["demo-skill"] }), context(ui.ui))).toBe(0);
    expect(ui.text()).toContain(`  ./.claude/skills/demo-skill (link) → ${outsideLink} (outside the project)\n  ./.agents/skills/demo-skill`);
    expect(present(join(cwd, ".agents/skills/demo-skill"))).toBe(false);
    expect(present(outsideLink)).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("removes what it can, names each path it cannot, and returns 1", async () => {
    const { cwd, context, install } = setup();
    await installBoth(install);
    chmodSync(join(cwd, ".claude/skills"), 0o555);
    try {
      const ui = fakeUi();
      expect(await runRemove(removeOptions({ all: true, yes: true }), context(ui.ui))).toBe(1);
      expect(ui.text()).toMatch(
        /^error: Failed to remove 2 paths\n✗ \.\/\.claude\/skills\/demo-skill: [^\n]*EACCES[^\n]*\n✗ \.\/\.claude\/skills\/other-skill: [^\n]*EACCES/m,
      );
      expect(ui.text()).not.toContain("Removed");
      expect(ui.text()).toMatch(/Done!$/);
      expect(left(cwd)).toEqual({ agents: [], claude: ["demo-skill", "other-skill"] });
    } finally {
      chmodSync(join(cwd, ".claude/skills"), 0o755);
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("warns about a folder it cannot read and still removes the rest", async () => {
    const { cwd, context, install } = setup();
    await install("demo-skill", ["claude-code"]);
    writeSkillMd(join(cwd, ".agents/skills/locked"), skillMd("locked"));
    chmodSync(join(cwd, ".agents/skills/locked"), 0o000);
    try {
      const ui = fakeUi();
      expect(await runRemove(removeOptions({ skills: ["demo-skill"], yes: true }), context(ui.ui))).toBe(0);
      expect(ui.text()).toContain("warn: Cannot read ./.agents/skills/locked/SKILL.md (EACCES)");
      expect(left(cwd)).toEqual({ agents: ["locked"], claude: [] });
    } finally {
      chmodSync(join(cwd, ".agents/skills/locked"), 0o755);
    }
  });

  it("prints no terminal escapes or install keys found in a skill's name", async () => {
    const { cwd, context } = setup();
    writeSkillMd(join(cwd, ".agents/skills/evil"), '---\nname: "evil\\e]52;c;ZXZpbA==\\a"\ndescription: Demo.\n---\n');
    writeSkillMd(join(cwd, ".agents/skills/keyed"), '---\nname: "https://h.example/i/abcdefghijkl"\ndescription: Demo.\n---\n');
    const ui = fakeUi({ selectInstalled: [0, 1], confirm: true });
    expect(await runRemove(removeOptions(), context(ui.ui))).toBe(0);
    expect(ui.text()).toContain("✓ evil]52;c;ZXZpbA==");
    expect(ui.text()).toContain("✓ https://h.example/i/abcd…");
    expect(ui.text()).not.toMatch(/[\x1b\x07]/);
    expect(ui.text()).not.toContain("abcdefghijkl");
    expect(left(cwd).agents).toEqual([]);
  });
});
