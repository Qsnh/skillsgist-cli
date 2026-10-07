import { basename, dirname } from "node:path";
import { agentsById, loadAgents, skillsRoot, type AgentEnvironment, type Scope } from "./agents.js";
import { locator, sanitizeName, type Locator } from "./installer.js";
import { findInstalledSkills, type InstalledEntry } from "./list-skills.js";
import { isInside, shortPath } from "./paths.js";

export interface RemoveOptions {
  global: boolean;
  agents: string[] | null;
  skills: string[];
  all: boolean;
  yes: boolean;
}

export interface Removal {
  name: string;
  path: string;
  entries: InstalledEntry[];
  keptBy: string[];
}

export interface Vetting {
  outside: Map<string, string>;
  refusals: string[];
}

export async function findRemovals(environment: AgentEnvironment, options: RemoveOptions): Promise<{ removals: Removal[]; problems: string[] }> {
  const named = options.agents?.filter((id) => id !== "*") ?? [];
  const filtered = options.agents !== null && !options.agents.includes("*");
  const scope: Scope = { global: options.global, home: environment.home, cwd: environment.cwd };
  const targets = filtered
    ? new Set(
        agentsById(loadAgents(environment), named)
          .map((agent) => skillsRoot(agent, scope))
          .filter((dir): dir is string => dir !== null),
      )
    : new Set<string>();
  const { skills, problems } = await findInstalledSkills(environment, {
    global: options.global,
    project: !options.global,
    agents: filtered ? ["*"] : options.agents,
    json: false,
  });
  const removals: Removal[] = [];
  for (const skill of skills) {
    const chosen = filtered ? skill.entries.filter((entry) => targets.has(dirname(entry.path))) : skill.entries;
    if (chosen.length === 0) continue;
    const keptBy =
      filtered && chosen.some((entry) => !entry.linked)
        ? skill.entries.filter((entry) => !chosen.includes(entry)).map((entry) => entry.path)
        : [];
    const entries = [...chosen].sort((a, b) => Number(b.linked) - Number(a.linked));
    removals.push({ name: skill.name, path: skill.path, entries, keptBy });
  }
  return { removals, problems };
}

export function pickRemovals(removals: Removal[], names: string[]): { picked: Removal[]; missing: string[] } {
  const requested = [...new Set(names)];
  const matched = new Set<Removal>();
  const missing: string[] = [];
  for (const name of requested) {
    const want = sanitizeName(name);
    const hits = removals.filter(
      (removal) => sanitizeName(removal.name) === want || removal.entries.some((entry) => sanitizeName(basename(entry.path)) === want),
    );
    if (hits.length === 0) missing.push(name);
    else for (const hit of hits) matched.add(hit);
  }
  return { picked: removals.filter((removal) => matched.has(removal)), missing };
}

export async function vetRemovals(
  removals: Removal[],
  environment: AgentEnvironment,
  options: { global: boolean; yes: boolean },
  where: Locator = locator(),
): Promise<Vetting> {
  const { home, cwd } = environment;
  const short = (path: string) => shortPath(path, home, cwd);
  const outside = new Map<string, string>();
  const refusals: string[] = [];
  for (const removal of removals) {
    if (removal.keptBy.length === 0) continue;
    const real = removal.entries.find((entry) => !entry.linked);
    if (real === undefined) continue;
    refusals.push(`${short(real.path)} is still linked from ${removal.keptBy.map(short).join(", ")}; add those agents to -a, or leave out -a`);
  }
  if (!options.global) {
    const root = await where.real(cwd);
    for (const removal of removals) {
      for (const entry of removal.entries) {
        const located = await where.located(entry.path);
        if (isInside(root, located)) continue;
        outside.set(entry.path, located);
        if (options.yes) refusals.push(`${short(entry.path)} leads out of the project to ${located}; remove from a terminal without -y to confirm`);
      }
    }
    if (options.yes) {
      const scope: Scope = { global: false, home, cwd };
      const ownedRoots = new Set(
        loadAgents(environment)
          .filter((agent) => agent.projectOwned)
          .map((agent) => skillsRoot(agent, scope))
          .filter((dir): dir is string => dir !== null),
      );
      for (const removal of removals) {
        for (const entry of removal.entries) {
          if (entry.linked || !ownedRoots.has(dirname(entry.path))) continue;
          refusals.push(`${short(entry.path)} is not a link, and the project keeps its own skills there; remove from a terminal without -y to confirm`);
        }
      }
    }
  }
  return { outside, refusals };
}
