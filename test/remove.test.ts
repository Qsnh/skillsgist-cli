import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgents, type AgentEnvironment } from "../src/agents.js";
import { installSkill, type InstallOptions } from "../src/installer.js";
import { shortPath } from "../src/paths.js";
import { findRemovals, pickRemovals, vetRemovals, type RemoveOptions } from "../src/remove.js";
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
