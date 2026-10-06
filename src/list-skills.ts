import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { canonicalSkillsRoot, loadAgents, skillsRoot, type Agent, type AgentEnvironment, type Scope } from "./agents.js";
import { ownCopySkillName, skillName } from "./archive.js";
import { CliError } from "./errors.js";
import { homePath } from "./paths.js";
import { oneLine, printable, redact } from "./source.js";

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

interface FoundSkill {
  name: string;
  path: string;
  agents: Agent[];
}

function byId(a: Agent, b: Agent): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function listedScopes(options: ListOptions): ListScope[] {
  if (options.global === options.project) return ["project", "global"];
  return options.global ? ["global"] : ["project"];
}

function candidateAgents(agents: Agent[], options: ListOptions): { candidates: Agent[]; filtered: boolean } {
  const requested = options.agents;
  if (requested === null || requested.includes("*")) return { candidates: agents, filtered: false };
  const unique = [...new Set(requested)];
  const byAgentId = new Map(agents.map((agent) => [agent.id, agent]));
  const invalid = unique.filter((id) => !byAgentId.has(id));
  if (invalid.length > 0) {
    throw new CliError(`Invalid agents: ${invalid.join(", ")}. Valid agents: ${agents.map((agent) => agent.id).join(", ")}`);
  }
  return { candidates: unique.map((id) => byAgentId.get(id) as Agent), filtered: true };
}

function directoryAgents(scope: Scope, candidates: Agent[], filtered: boolean): Map<string, Agent[]> {
  const dirs = new Map<string, Agent[]>();
  for (const agent of candidates) {
    if (agent.projectOwned && !agent.installed && !filtered) continue;
    const root = skillsRoot(agent, scope);
    if (root === null) continue;
    const list = dirs.get(root);
    if (list) list.push(agent);
    else dirs.set(root, [agent]);
  }
  for (const list of dirs.values()) list.sort(byId);
  return dirs;
}

function orderedDirs(scope: Scope, dirs: Map<string, Agent[]>): string[] {
  const canonical = canonicalSkillsRoot(scope);
  return [...dirs.keys()].sort((a, b) => {
    if (a === canonical) return b === canonical ? 0 : -1;
    if (b === canonical) return 1;
    return byId(dirs.get(a)![0], dirs.get(b)![0]);
  });
}

function namedAgents(agents: Agent[], filtered: boolean): Agent[] {
  return filtered || agents.length === 1 ? agents : agents.filter((agent) => agent.installed);
}

async function realOrResolved(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    return resolve(dir);
  }
}

async function scanDirectory(dir: string, agents: Agent[], ownCopy: boolean): Promise<FoundSkill[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const found: FoundSkill[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;
    const skillMdPath = join(path, "SKILL.md");
    let skillMdInfo;
    try {
      skillMdInfo = await stat(skillMdPath);
    } catch {
      continue;
    }
    if (!skillMdInfo.isFile()) continue;
    let contents: string;
    try {
      contents = await readFile(skillMdPath, "utf8");
    } catch {
      continue;
    }
    const name = ownCopy ? ownCopySkillName(contents, entry.name) : skillName(contents);
    if (name === null) continue;
    found.push({ name, path, agents });
  }
  return found;
}

async function scanScope(scope: Scope, candidates: Agent[], filtered: boolean, skip: Set<string>): Promise<InstalledSkill[]> {
  const dirs = directoryAgents(scope, candidates, filtered);
  const order = orderedDirs(scope, dirs);
  const merged = new Map<string, InstalledSkill>();
  for (const dir of order) {
    if (skip.size > 0 && skip.has(await realOrResolved(dir))) continue;
    const dirAgents = dirs.get(dir)!;
    const found = await scanDirectory(dir, namedAgents(dirAgents, filtered), dirAgents.some((agent) => agent.ownCopy));
    for (const skill of found) {
      const existing = merged.get(skill.name);
      if (existing === undefined) {
        merged.set(skill.name, { name: skill.name, scope: scope.global ? "global" : "project", path: skill.path, agents: [...skill.agents] });
      } else {
        for (const agent of skill.agents) if (!existing.agents.includes(agent)) existing.agents.push(agent);
      }
    }
  }
  const result = [...merged.values()];
  result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const skill of result) skill.agents.sort(byId);
  return result;
}

export async function findInstalledSkills(environment: AgentEnvironment, options: ListOptions): Promise<InstalledSkill[]> {
  const agents = loadAgents(environment);
  const { candidates, filtered } = candidateAgents(agents, options);
  const scopes = listedScopes(options);
  const scopeOf = (global: boolean): Scope => ({ global, home: environment.home, cwd: environment.cwd });
  const skip = new Set<string>();
  if (scopes.includes("project") && scopes.includes("global")) {
    const globalDirs = directoryAgents(scopeOf(true), candidates, filtered).keys();
    for (const dir of await Promise.all([...globalDirs].map(realOrResolved))) skip.add(dir);
  }
  const results: InstalledSkill[] = [];
  for (const scope of scopes) {
    results.push(...(await scanScope(scopeOf(scope === "global"), candidates, filtered, scope === "project" ? skip : new Set())));
  }
  return results;
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
  if (skill.scope === "global") return homePath(skill.path, place.home);
  return `.${sep}${relative(place.cwd, skill.path)}`;
}

function textTable(skills: InstalledSkill[], place: { home: string; cwd: string }): string[] {
  const header = ["NAME", "PATH", "AGENTS"];
  const rows = skills.map((skill) => [
    textCell(skill.name),
    textCell(displayPath(skill, place)),
    textCell(agentNames(skill.agents).join(", ") || "—"),
  ]);
  const table = [header, ...rows];
  const widths = header.slice(0, -1).map((_, column) => Math.max(...table.map((cells) => cells[column].length)));
  return table.map((cells) => [...widths.map((width, column) => cells[column].padEnd(width)), cells[widths.length]].join("  "));
}

function textSection(scope: ListScope, skills: InstalledSkill[], place: { home: string; cwd: string }): string {
  if (skills.length === 0) return `No ${scope} skills`;
  const count = skills.length;
  const label = `${count} ${scope} skill${count === 1 ? "" : "s"}`;
  return [label, "", ...textTable(skills, place)].join("\n");
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
