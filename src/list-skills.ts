import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalSkillsRoot, loadAgents, skillsRoot, type Agent, type AgentEnvironment, type Scope } from "./agents.js";
import { skillName } from "./archive.js";
import { CliError } from "./errors.js";

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

function directoryAgents(scope: Scope, candidates: Agent[]): Map<string, Agent[]> {
  const dirs = new Map<string, Agent[]>();
  for (const agent of candidates) {
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

async function scanDirectory(dir: string, agents: Agent[]): Promise<FoundSkill[]> {
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
    let contents: string;
    try {
      contents = await readFile(join(path, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const name = skillName(contents);
    if (name === null) continue;
    found.push({ name, path, agents });
  }
  return found;
}

async function scanScope(scope: Scope, candidates: Agent[], filtered: boolean, skip: Set<string>): Promise<InstalledSkill[]> {
  const dirs = directoryAgents(scope, candidates);
  const order = orderedDirs(scope, dirs);
  const merged = new Map<string, InstalledSkill>();
  for (const dir of order) {
    if (skip.has(resolve(dir))) continue;
    const found = await scanDirectory(dir, namedAgents(dirs.get(dir)!, filtered));
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
    for (const dir of directoryAgents(scopeOf(true), candidates).keys()) skip.add(resolve(dir));
  }
  const results: InstalledSkill[] = [];
  for (const scope of scopes) {
    results.push(...(await scanScope(scopeOf(scope === "global"), candidates, filtered, scope === "project" ? skip : new Set())));
  }
  return results;
}
