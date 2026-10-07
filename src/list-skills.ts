import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { agentsById, canonicalSkillsRoot, loadAgents, skillsRoot, type Agent, type AgentEnvironment, type Scope } from "./agents.js";
import { skillName } from "./archive.js";
import { compareBy, formatTable, plural } from "./format.js";
import { locator, type Locator } from "./installer.js";
import { homePath, projectPath, shortPath, within } from "./paths.js";
import { displayLine, displayText } from "./source.js";

const FRONTMATTER_BYTES = 64 * 1024;
const NOT_A_SKILL = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

export interface ListOptions {
  global: boolean;
  project: boolean;
  agents: string[] | null;
  json: boolean;
}

export type ListScope = "project" | "global";

export interface InstalledSkill {
  name: string;
  scope: ListScope;
  path: string;
  agents: Agent[];
}

export interface Listing {
  skills: InstalledSkill[];
  problems: string[];
}

interface Filter {
  agents: Agent[];
  everyFolder: boolean;
  nameAll: boolean;
}

interface Folder {
  dir: string;
  agents: Agent[];
  onlyLinksTo: string | null;
}

interface Scan {
  where: Locator;
  failed(path: string, err: unknown): null;
}

interface Found {
  name: string;
  path: string;
  real: string;
  linked: boolean;
}

const byId = compareBy((agent: Agent) => agent.id);
const byName = compareBy((item: { name: string }) => item.name);

export function listedScopes(options: ListOptions): ListScope[] {
  if (options.global === options.project) return ["project", "global"];
  return options.global ? ["global"] : ["project"];
}

function agentFilter(agents: Agent[], requested: string[] | null): Filter {
  if (requested === null) return { agents, everyFolder: false, nameAll: false };
  const named = agentsById(agents, requested.filter((id) => id !== "*"));
  if (requested.includes("*")) return { agents, everyFolder: true, nameAll: false };
  return { agents: named, everyFolder: true, nameAll: true };
}

function scopeFolders(scope: Scope, filter: Filter): Folder[] {
  const dirs = new Map<string, Agent[]>();
  for (const agent of filter.agents) {
    const root = skillsRoot(agent, scope);
    if (root === null) continue;
    const list = dirs.get(root);
    if (list) list.push(agent);
    else dirs.set(root, [agent]);
  }
  for (const list of dirs.values()) list.sort(byId);
  const canonical = canonicalSkillsRoot(scope);
  return [...dirs]
    .sort(([a, first], [b, second]) => (a === canonical ? -1 : b === canonical ? 1 : byId(first[0], second[0])))
    .map(([dir, agents]) => ({
      dir,
      agents: filter.nameAll || agents.length === 1 ? agents : agents.filter((agent) => agent.installed),
      onlyLinksTo: !scope.global && !filter.everyFolder && agents.every((agent) => agent.projectOwned && !agent.detectedInProject) ? canonical : null,
    }));
}

async function readSkillName(skillMd: string): Promise<string | null> {
  const info = await stat(skillMd);
  if (!info.isFile()) return null;
  const handle = await open(skillMd);
  try {
    const head = Buffer.alloc(Math.min(info.size, FRONTMATTER_BYTES));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return skillName(head.toString("utf8", 0, bytesRead));
  } finally {
    await handle.close();
  }
}

async function scanDirectory(folder: Folder, scan: Scan): Promise<Found[]> {
  const entries = await readdir(folder.dir, { withFileTypes: true }).catch((err: unknown): Dirent[] => {
    scan.failed(folder.dir, err);
    return [];
  });
  entries.sort(byName);
  const found = await Promise.all(
    entries.map(async (entry): Promise<Found | null> => {
      const path = join(folder.dir, entry.name);
      const linked = entry.isSymbolicLink();
      if (folder.onlyLinksTo !== null && !linked) return null;
      const skillMd = join(path, "SKILL.md");
      const name = await readSkillName(skillMd).catch((err: unknown) => scan.failed(skillMd, err));
      if (name === null) return null;
      const real = await (linked ? scan.where.real(path) : scan.where.located(path));
      if (folder.onlyLinksTo !== null && within(await scan.where.real(folder.onlyLinksTo), real) === null) return null;
      return { name, path, real, linked };
    }),
  );
  return found.filter((skill) => skill !== null);
}

async function scanScope(scope: Scope, folders: Folder[], scan: Scan, skip: Promise<Set<string>> | null): Promise<InstalledSkill[]> {
  const listed: ListScope = scope.global ? "global" : "project";
  const skipped = async (dir: string) => {
    if (skip === null) return false;
    const [reals, real] = await Promise.all([skip, scan.where.real(dir)]);
    return reals.has(real);
  };
  const scanned = await Promise.all(
    folders.map(async (folder) => ((await skipped(folder.dir)) ? [] : (await scanDirectory(folder, scan)).map((found) => ({ ...found, agents: folder.agents })))),
  );
  const byFolder = new Map<string, InstalledSkill>();
  for (const found of scanned.flat().sort((a, b) => Number(a.linked) - Number(b.linked))) {
    const existing = byFolder.get(found.real);
    if (existing === undefined) byFolder.set(found.real, { name: found.name, scope: listed, path: found.path, agents: [...found.agents] });
    else for (const agent of found.agents) if (!existing.agents.includes(agent)) existing.agents.push(agent);
  }
  const result = [...byFolder.values()];
  result.sort(byName);
  for (const skill of result) skill.agents.sort(byId);
  return result;
}

export async function findInstalledSkills(environment: AgentEnvironment, options: ListOptions): Promise<Listing> {
  const filter = agentFilter(loadAgents(environment), options.agents);
  const where = locator();
  const problems: string[] = [];
  const scan: Scan = {
    where,
    failed(path, err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !NOT_A_SKILL.has(code)) problems.push(`Cannot read ${shortPath(path, environment.home, environment.cwd)} (${code ?? String(err)})`);
      return null;
    },
  };
  const planned = listedScopes(options).map((listed) => {
    const scope: Scope = { global: listed === "global", home: environment.home, cwd: environment.cwd };
    return { scope, folders: scopeFolders(scope, filter) };
  });
  const global = planned.find((plan) => plan.scope.global);
  const globalReals = global === undefined ? null : Promise.all(global.folders.map((folder) => where.real(folder.dir))).then((reals) => new Set(reals));
  const found = await Promise.all(planned.map((plan) => scanScope(plan.scope, plan.folders, scan, plan.scope.global ? null : globalReals)));
  return { skills: found.flat(), problems: problems.sort() };
}

function displayPath(skill: InstalledSkill, place: { home: string; cwd: string }): string {
  return skill.scope === "global" ? homePath(skill.path, place.home) : projectPath(skill.path, place.cwd);
}

function textSection(scope: ListScope, skills: InstalledSkill[], place: { home: string; cwd: string }): string {
  if (skills.length === 0) return `No ${scope} skills`;
  const rows = skills.map((skill) => [
    displayLine(skill.name),
    displayLine(displayPath(skill, place)),
    displayLine(skill.agents.map((agent) => agent.displayName).join(", ") || "—"),
  ]);
  return [plural(skills.length, `${scope} skill`), "", ...formatTable([["NAME", "PATH", "AGENTS"], ...rows])].join("\n");
}

function jsonRow(skill: InstalledSkill): { name: string; path: string; scope: ListScope; agents: string[] } {
  return {
    name: displayText(skill.name),
    path: skill.path,
    scope: skill.scope,
    agents: skill.agents.map((agent) => agent.id),
  };
}

export function formatInstalledSkills(skills: InstalledSkill[], options: ListOptions, place: { home: string; cwd: string }): string {
  const scopes = listedScopes(options);
  const byScope = (scope: ListScope) => skills.filter((skill) => skill.scope === scope);
  if (options.json) {
    const rows = scopes.flatMap((scope) => byScope(scope).map(jsonRow));
    return `${JSON.stringify(rows, null, 2)}\n`;
  }
  const sections = scopes.map((scope) => textSection(scope, byScope(scope), place));
  return `${sections.join("\n\n")}\n`;
}

export async function listSkills(environment: AgentEnvironment, options: ListOptions): Promise<{ output: string; problems: string[] }> {
  const { skills, problems } = await findInstalledSkills(environment, options);
  return { output: formatInstalledSkills(skills, options, environment), problems };
}
