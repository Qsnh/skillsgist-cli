import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { agentsById, canonicalSkillsRoot, loadAgents, skillsRoot, type Agent, type AgentEnvironment, type Scope } from "./agents.js";
import { skillName } from "./archive.js";
import { formatTable, plural } from "./format.js";
import { locator, type Locator } from "./installer.js";
import { homePath, projectPath } from "./paths.js";
import { oneLine, printable, redact } from "./source.js";

const FRONTMATTER_BYTES = 64 * 1024;

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

interface Filter {
  agents: Agent[];
  everyFolder: boolean;
  nameAll: boolean;
}

interface Found {
  name: string;
  path: string;
  real: string;
  linked: boolean;
}

function byId(a: Agent, b: Agent): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function listedScopes(options: ListOptions): ListScope[] {
  if (options.global === options.project) return ["project", "global"];
  return options.global ? ["global"] : ["project"];
}

function agentFilter(agents: Agent[], requested: string[] | null): Filter {
  if (requested === null) return { agents, everyFolder: false, nameAll: false };
  if (requested.includes("*")) return { agents, everyFolder: true, nameAll: false };
  return { agents: agentsById(agents, requested), everyFolder: true, nameAll: true };
}

function scopeFolders(scope: Scope, filter: Filter): Array<[string, Agent[]]> {
  const dirs = new Map<string, Agent[]>();
  for (const agent of filter.agents) {
    if (agent.projectOwned && !agent.installed && !filter.everyFolder) continue;
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
    .map(([dir, agents]): [string, Agent[]] => [dir, filter.nameAll || agents.length === 1 ? agents : agents.filter((agent) => agent.installed)]);
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

async function scanDirectory(dir: string, where: Locator): Promise<Found[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const found = await Promise.all(
    entries.map(async (entry): Promise<Found | null> => {
      const path = join(dir, entry.name);
      const name = await readSkillName(join(path, "SKILL.md")).catch(() => null);
      if (name === null) return null;
      const linked = entry.isSymbolicLink();
      return { name, path, real: await (linked ? where.real(path) : where.located(path)), linked };
    }),
  );
  return found.filter((skill) => skill !== null);
}

async function scanScope(scope: Scope, folders: Array<[string, Agent[]]>, where: Locator, skip: Set<string>): Promise<InstalledSkill[]> {
  const listed: ListScope = scope.global ? "global" : "project";
  const scanned = await Promise.all(
    folders.map(async ([dir, agents]) => (skip.size > 0 && skip.has(await where.real(dir)) ? [] : (await scanDirectory(dir, where)).map((found) => ({ ...found, agents })))),
  );
  const byFolder = new Map<string, InstalledSkill>();
  for (const found of scanned.flat().sort((a, b) => Number(a.linked) - Number(b.linked))) {
    const existing = byFolder.get(found.real);
    if (existing === undefined) byFolder.set(found.real, { name: found.name, scope: listed, path: found.path, agents: [...found.agents] });
    else for (const agent of found.agents) if (!existing.agents.includes(agent)) existing.agents.push(agent);
  }
  const result = [...byFolder.values()];
  result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const skill of result) skill.agents.sort(byId);
  return result;
}

export async function findInstalledSkills(environment: AgentEnvironment, options: ListOptions): Promise<InstalledSkill[]> {
  const filter = agentFilter(loadAgents(environment), options.agents);
  const where = locator();
  const planned = listedScopes(options).map((listed) => {
    const scope: Scope = { global: listed === "global", home: environment.home, cwd: environment.cwd };
    return { scope, folders: scopeFolders(scope, filter) };
  });
  const global = planned.find((plan) => plan.scope.global);
  const globalReals = new Set(global === undefined ? [] : await Promise.all(global.folders.map(([dir]) => where.real(dir))));
  const found = await Promise.all(planned.map((plan) => scanScope(plan.scope, plan.folders, where, plan.scope.global ? new Set() : globalReals)));
  return found.flat();
}

function textCell(text: string): string {
  return redact(oneLine(text));
}

function jsonCell(text: string): string {
  return redact(printable(text));
}

function agentNames(agents: Agent[]): string[] {
  return agents.map((agent) => agent.displayName);
}

function displayPath(skill: InstalledSkill, place: { home: string; cwd: string }): string {
  return skill.scope === "global" ? homePath(skill.path, place.home) : projectPath(skill.path, place.cwd);
}

function textSection(scope: ListScope, skills: InstalledSkill[], place: { home: string; cwd: string }): string {
  if (skills.length === 0) return `No ${scope} skills`;
  const rows = skills.map((skill) => [
    textCell(skill.name),
    textCell(displayPath(skill, place)),
    textCell(agentNames(skill.agents).join(", ") || "—"),
  ]);
  return [plural(skills.length, `${scope} skill`), "", ...formatTable([["NAME", "PATH", "AGENTS"], ...rows])].join("\n");
}

function jsonRow(skill: InstalledSkill): { name: string; path: string; scope: ListScope; agents: string[] } {
  return {
    name: jsonCell(skill.name),
    path: jsonCell(skill.path),
    scope: skill.scope,
    agents: agentNames(skill.agents).map(jsonCell),
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

export async function listSkills(environment: AgentEnvironment, options: ListOptions): Promise<string> {
  return formatInstalledSkills(await findInstalledSkills(environment, options), options, environment);
}
