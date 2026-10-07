import { readlink, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CANCELLED, cancelled, type Cancellable, type Ui } from "./add.js";
import { agentFilter, detectRunningAgent, loadAgents, skillsRoot, type Agent, type AgentEnvironment, type AgentFilter, type Exists, type Scope } from "./agents.js";
import { CliError, errorMessage } from "./errors.js";
import { plural } from "./format.js";
import { locator, projectGuard, sanitizeName, type Locator } from "./installer.js";
import { findInstalledSkills, type InstalledEntry } from "./list-skills.js";
import { shortPath, within } from "./paths.js";
import { displayLine } from "./source.js";

export interface RemoveOptions {
  global: boolean;
  agents: string[] | null;
  skills: string[];
  all: boolean;
  yes: boolean;
}

export interface Kept {
  path: string;
  through: string;
  same: boolean;
  agent: string;
}

export interface Removal {
  name: string;
  path: string;
  entries: InstalledEntry[];
  keptBy: Kept[];
}

export interface Vetting {
  located: Map<string, string>;
  outside: Set<string>;
  refusals: Map<Removal, string[]>;
}

export interface RemoveContext {
  ui: Ui;
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  exists?: Exists;
}

interface Lookup {
  agents: Agent[];
  filter: AgentFilter;
  where: Locator;
}

type Short = (path: string) => string;

type Candidate = Omit<Removal, "keptBy"> & { others: InstalledEntry[] };

const CONFIRM_HINT = "run it in a terminal without -y or --all to confirm";
const MAX_HOPS = 40;

function lookup(environment: AgentEnvironment, options: RemoveOptions): Lookup {
  const agents = loadAgents(environment);
  return { agents, filter: agentFilter(agents, options.agents), where: locator() };
}

function owners(agents: Agent[], scope: Scope): Map<string, string> {
  const byDir = new Map<string, Agent>();
  for (const agent of agents) {
    const dir = skillsRoot(agent, scope);
    if (dir === null) continue;
    const current = byDir.get(dir);
    if (current === undefined || (!current.installed && agent.installed)) byDir.set(dir, agent);
  }
  return new Map([...byDir].map(([dir, agent]) => [dir, agent.id]));
}

async function hops(path: string, where: Locator): Promise<string[]> {
  const places: string[] = [];
  let next: string | null = path;
  while (next !== null && places.length < MAX_HOPS) {
    const place = await where.located(next);
    if (places.includes(place)) break;
    places.push(place);
    const target = await readlink(place).catch(() => null);
    next = target === null ? null : resolve(dirname(place), target);
  }
  return places;
}

async function keptEntries(chosen: InstalledEntry[], others: InstalledEntry[], agentIn: Map<string, string>, where: Locator): Promise<Kept[]> {
  const [places, paths] = await Promise.all([
    Promise.all(chosen.map((entry) => where.located(entry.path))),
    Promise.all(others.map((other) => hops(other.path, where))),
  ]);
  const kept: Kept[] = [];
  others.forEach((other, index) => {
    const path = paths[index];
    const hit = path.findIndex((place) => places.includes(place));
    if (hit === -1) return;
    const through = chosen[places.indexOf(path[hit])];
    kept.push({ path: other.path, through: through.path, same: hit === 0, agent: agentIn.get(dirname(other.path)) as string });
  });
  return kept;
}

async function findCandidates(
  environment: AgentEnvironment,
  options: RemoveOptions,
  look: Lookup,
): Promise<{ candidates: Candidate[]; problems: string[] }> {
  const { filter } = look;
  const scope: Scope = { global: options.global, home: environment.home, cwd: environment.cwd };
  const targets = new Set(filter.agents.map((agent) => skillsRoot(agent, scope)));
  const { skills, problems } = await findInstalledSkills(
    environment,
    { global: options.global, project: !options.global, agents: filter.named ? ["*"] : options.agents, json: false },
    look,
  );
  const candidates: Candidate[] = [];
  for (const skill of skills) {
    const chosen = filter.named ? skill.entries.filter((entry) => targets.has(dirname(entry.path))) : skill.entries;
    if (chosen.length === 0) continue;
    const others = skill.entries.filter((entry) => !chosen.includes(entry));
    const entries = [...chosen].sort((a, b) => Number(b.linked) - Number(a.linked));
    candidates.push({ name: skill.name, path: skill.path, entries, others });
  }
  return { candidates, problems };
}

function withKeptBy(candidates: Candidate[], environment: AgentEnvironment, options: RemoveOptions, look: Lookup): Promise<Removal[]> {
  const scope: Scope = { global: options.global, home: environment.home, cwd: environment.cwd };
  const agentIn = look.filter.named ? owners(look.agents, scope) : new Map<string, string>();
  return Promise.all(
    candidates.map(async ({ others, ...removal }) => ({
      ...removal,
      keptBy: others.length === 0 ? [] : await keptEntries(removal.entries, others, agentIn, look.where),
    })),
  );
}

export async function findRemovals(
  environment: AgentEnvironment,
  options: RemoveOptions,
  look: Lookup = lookup(environment, options),
): Promise<{ removals: Removal[]; problems: string[] }> {
  const { candidates, problems } = await findCandidates(environment, options, look);
  return { removals: await withKeptBy(candidates, environment, options, look), problems };
}

export function pickRemovals<T extends Pick<Removal, "name" | "entries">>(removals: T[], names: string[]): { picked: T[]; missing: string[] } {
  const requested = [...new Set(names)];
  const matched = new Set<T>();
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

async function unaliased(bases: string[], where: Locator): Promise<(place: string) => string> {
  const reals = await Promise.all(bases.map(async (base): Promise<[string, string]> => [await where.real(base), base]));
  reals.sort(([a], [b]) => b.length - a.length);
  return (place) => {
    for (const [real, base] of reals) {
      const rest = within(real, place);
      if (rest !== null) return join(base, rest);
    }
    return place;
  };
}

function keptReasons(removal: Removal, short: Short): string[] {
  const reasons: string[] = [];
  for (const entry of removal.entries) {
    const kept = removal.keptBy.filter((other) => other.through === entry.path);
    if (kept.length === 0) continue;
    const same = kept.filter((other) => other.same).map((other) => short(other.path));
    const linking = kept.filter((other) => !other.same).map((other) => short(other.path));
    const why = [
      ...(same.length > 0 ? [`is the same ${entry.linked ? "link" : "folder"} as ${same.join(", ")}`] : []),
      ...(linking.length > 0 ? [`is still linked from ${linking.join(", ")}`] : []),
    ];
    const agents = [...new Set(kept.map((other) => other.agent))];
    reasons.push(`${short(entry.path)} ${why.join(", and ")}; add ${agents.join(", ")} to -a, or leave out -a`);
  }
  return reasons;
}

export async function vetRemovals(
  removals: Removal[],
  environment: AgentEnvironment,
  options: { global: boolean; yes: boolean },
  where: Locator = locator(),
): Promise<Vetting> {
  const { home, cwd } = environment;
  const short = (path: string) => shortPath(path, home, cwd);
  const shown = await unaliased(options.global ? [home, cwd] : [cwd, home], where);
  const guard = options.global ? null : projectGuard(cwd, where);
  const located = new Map<string, string>();
  const outside = new Set<string>();
  const refusals = new Map<Removal, string[]>();
  const checked = await Promise.all(
    removals.map((removal) =>
      Promise.all(
        removal.entries.map(async (entry) => ({
          entry,
          place: shown(await where.located(entry.path)),
          away: guard === null ? null : await guard.outside(entry.path),
          owned: guard !== null && options.yes && !entry.linked && (await guard.owned(entry.path)),
        })),
      ),
    ),
  );
  removals.forEach((removal, index) => {
    const reasons = keptReasons(removal, short);
    for (const { entry, place, away, owned } of checked[index]) {
      if (place !== entry.path) located.set(entry.path, place);
      if (away !== null) {
        outside.add(entry.path);
        if (options.yes) reasons.push(`${short(entry.path)} leads out of the project to ${shown(away)}; ${CONFIRM_HINT}`);
      }
      if (owned) reasons.push(`${short(entry.path)} is not a link, and the project keeps its own skills there; ${CONFIRM_HINT}`);
    }
    if (reasons.length > 0) refusals.set(removal, reasons);
  });
  return { located, outside, refusals };
}

async function notInstalled(missing: string[], removals: Candidate[], environment: AgentEnvironment, options: RemoveOptions, look: Lookup): Promise<CliError> {
  const forAgents = look.filter.named ? ` for ${look.filter.agents.map((agent) => agent.id).join(", ")}` : "";
  const place = options.global ? "globally" : "in the project";
  const installed = [...new Set(removals.map((removal) => displayLine(removal.name)))];
  const there = installed.length > 0 ? `Installed there: ${installed.join(", ")}` : "Nothing is installed there.";
  const lines = [`Not installed ${place}${forAgents}: ${missing.map(displayLine).join(", ")}. ${there}`];
  const other = await findCandidates(environment, { ...options, global: !options.global }, look);
  const absent = pickRemovals(other.candidates, missing).missing;
  const found = missing.filter((name) => !absent.includes(name)).map(displayLine);
  if (found.length > 0) {
    lines.push(options.global ? `Installed in the project: ${found.join(", ")} (leave out -g)` : `Installed globally: ${found.join(", ")} (add -g)`);
  }
  return new CliError(lines.join("\n"));
}

async function namedRemovals(candidates: Candidate[], environment: AgentEnvironment, options: RemoveOptions, look: Lookup): Promise<Removal[]> {
  const { picked, missing } = pickRemovals(candidates, options.skills);
  if (missing.length > 0) throw await notInstalled(missing, candidates, environment, options, look);
  return withKeptBy(picked, environment, options, look);
}

function unrefused(removals: Removal[], vetting: Vetting): Removal[] {
  const refusals = removals.flatMap((removal) => vetting.refusals.get(removal) ?? []);
  if (refusals.length > 0) throw new CliError(["Nothing was removed:", ...refusals.map(displayLine)].join("\n"));
  return removals;
}

function hint(removal: Removal, short: Short): string {
  const marked = (entry: InstalledEntry) => `${short(entry.path)}${entry.linked ? " (link)" : ""}`;
  const own = removal.entries.find((entry) => entry.path === removal.path);
  return own === undefined ? removal.entries.map(marked).join(", ") : marked(own);
}

async function chooseRemovals(removals: Removal[], vetting: Vetting, all: boolean, ui: Ui, short: Short): Promise<Cancellable<Removal[]>> {
  const allowed = removals.filter((removal) => !vetting.refusals.has(removal));
  const skipped = removals.length - allowed.length;
  if (skipped > 0) ui.warn([`Skipping ${plural(skipped, "skill")}:`, ...[...vetting.refusals.values()].flat().map(displayLine)].join("\n"));
  if (all || allowed.length === 0) return allowed;
  const chosen = await ui.selectInstalled(allowed.map((removal) => ({ name: displayLine(removal.name), path: hint(removal, short) })));
  return chosen === CANCELLED ? CANCELLED : allowed.filter((_, index) => chosen.includes(index));
}

function summary(removals: Removal[], vetting: Vetting, short: Short): string {
  const line = (entry: InstalledEntry) => {
    const place = vetting.located.get(entry.path);
    const away = place === undefined ? "" : ` → ${short(place)}${vetting.outside.has(entry.path) ? " (outside the project)" : ""}`;
    return `  ${short(entry.path)}${entry.linked ? " (link)" : ""}${away}`;
  };
  return removals.map((removal) => [displayLine(removal.name), ...removal.entries.map(line)].join("\n")).join("\n\n");
}

async function removeEntries(removals: Removal[], short: Short): Promise<{ removed: Removal[]; failed: number; failures: string[] }> {
  const removed: Removal[] = [];
  const failures: string[] = [];
  let failed = 0;
  for (const removal of removals) {
    let linkFailed = false;
    let complete = true;
    for (const entry of removal.entries) {
      if (linkFailed && !entry.linked) {
        failures.push(`  ${short(entry.path)} was kept, because a link to it could not be removed`);
        continue;
      }
      try {
        await rm(entry.path, { recursive: true, force: true });
      } catch (err) {
        failed += 1;
        complete = false;
        failures.push(`✗ ${short(entry.path)}: ${displayLine(errorMessage(err))}`);
        if (entry.linked) linkFailed = true;
      }
    }
    if (complete) removed.push(removal);
  }
  return { removed, failed, failures };
}

function report(removed: Removal[], failed: number, failures: string[], ui: Ui): void {
  if (removed.length > 0) ui.note(removed.map((removal) => `✓ ${displayLine(removal.name)}`).join("\n"), `Removed ${plural(removed.length, "skill")}`);
  if (failed > 0) ui.error([`Failed to remove ${plural(failed, "path")}`, ...failures].join("\n"));
}

export async function runRemove(options: RemoveOptions, context: RemoveContext): Promise<number> {
  const { ui, home, cwd } = context;
  const running = detectRunningAgent(context.env, context.exists);
  const yes = options.yes || running.inAgent;
  if (!yes && !context.interactive) {
    throw new CliError("There is no terminal to ask questions in. Add -y to remove without prompts.");
  }
  if (yes && !options.all && options.skills.length === 0) throw new CliError("Name the skills to remove, or use --all", { showUsage: true });
  if (running.inAgent) {
    ui.info(`${running.name ?? "An agent"} detected — removing non-interactively`);
  } else {
    ui.intro("skillsgist");
  }

  const environment: AgentEnvironment = { home, cwd, env: context.env, exists: context.exists };
  const short = (path: string) => displayLine(shortPath(path, home, cwd));
  const look = lookup(environment, options);
  const { candidates, problems } = await findCandidates(environment, options, look);
  for (const problem of problems) ui.warn(displayLine(problem));
  const named = options.skills.length > 0;
  if (!named && candidates.length === 0) {
    ui.outro(`No ${options.global ? "global" : "project"} skills to remove`);
    return problems.length > 0 ? 1 : 0;
  }
  const removals = named ? await namedRemovals(candidates, environment, options, look) : await withKeptBy(candidates, environment, options, look);
  const vetting = await vetRemovals(removals, environment, { global: options.global, yes }, look.where);
  const chosen = named ? unrefused(removals, vetting) : await chooseRemovals(removals, vetting, options.all, ui, short);
  if (chosen === CANCELLED) return cancelled(ui, "Removal cancelled");
  const leftBehind = problems.length > 0 || (options.all && chosen.length < removals.length);
  if (chosen.length === 0) {
    ui.outro("Nothing was removed");
    return leftBehind ? 1 : 0;
  }
  ui.note(summary(chosen, vetting, short), "Removal Summary");
  if (!yes) {
    const proceed = await ui.confirm(`Remove ${plural(chosen.length, "skill")}?`);
    if (proceed === CANCELLED || !proceed) return cancelled(ui, "Removal cancelled");
  }

  const { removed, failed, failures } = await removeEntries(chosen, short);
  report(removed, failed, failures, ui);
  ui.outro("Done!");
  return failed > 0 || leftBehind ? 1 : 0;
}
