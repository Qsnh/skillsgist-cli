import { rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { CANCELLED, type Cancellable, type Ui } from "./add.js";
import { agentsById, detectRunningAgent, loadAgents, skillsRoot, type AgentEnvironment, type Exists, type Scope } from "./agents.js";
import { CliError } from "./errors.js";
import { plural } from "./format.js";
import { locator, sanitizeName, type Locator } from "./installer.js";
import { findInstalledSkills, type InstalledEntry } from "./list-skills.js";
import { isInside, shortPath } from "./paths.js";
import { displayLine } from "./source.js";

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
  located: Map<string, string>;
  outside: Set<string>;
  refusals: string[];
}

export interface RemoveContext {
  ui: Ui;
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  exists?: Exists;
}

type Short = (path: string) => string;

const CONFIRM_HINT = "run it in a terminal without -y or --all to confirm";

function ownedRoots(environment: AgentEnvironment): string[] {
  const scope: Scope = { global: false, home: environment.home, cwd: environment.cwd };
  return loadAgents(environment)
    .filter((agent) => agent.projectOwned)
    .map((agent) => skillsRoot(agent, scope))
    .filter((dir): dir is string => dir !== null);
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
  const located = new Map<string, string>();
  const outside = new Set<string>();
  const refusals: string[] = [];
  for (const removal of removals) {
    if (removal.keptBy.length === 0) continue;
    const real = removal.entries.find((entry) => !entry.linked);
    if (real === undefined) continue;
    refusals.push(`${short(real.path)} is still linked from ${removal.keptBy.map(short).join(", ")}; add those agents to -a, or leave out -a`);
  }
  const root = options.global ? null : await where.real(cwd);
  const owned = root !== null && options.yes ? new Set(await Promise.all(ownedRoots(environment).map((dir) => where.real(dir)))) : new Set<string>();
  for (const removal of removals) {
    for (const entry of removal.entries) {
      const place = await where.located(entry.path);
      if (place !== entry.path) located.set(entry.path, place);
      if (root === null) continue;
      if (!isInside(root, place)) {
        outside.add(entry.path);
        if (options.yes) refusals.push(`${short(entry.path)} leads out of the project to ${place}; ${CONFIRM_HINT}`);
      }
      if (!entry.linked && owned.has(dirname(place))) {
        refusals.push(`${short(entry.path)} is not a link, and the project keeps its own skills there; ${CONFIRM_HINT}`);
      }
    }
  }
  return { located, outside, refusals };
}

function cancelled(ui: Ui): number {
  ui.cancel("Removal cancelled");
  return 0;
}

async function notInstalled(missing: string[], removals: Removal[], environment: AgentEnvironment, options: RemoveOptions): Promise<CliError> {
  const named = options.agents?.filter((id) => id !== "*") ?? [];
  const forAgents = options.agents !== null && !options.agents.includes("*") ? ` for ${named.join(", ")}` : "";
  const place = options.global ? "globally" : "in the project";
  const installed = [...new Set(removals.map((removal) => displayLine(removal.name)))];
  const there = installed.length > 0 ? `Installed there: ${installed.join(", ")}` : "Nothing is installed there.";
  const lines = [`Not installed ${place}${forAgents}: ${missing.map(displayLine).join(", ")}. ${there}`];
  const other = await findRemovals(environment, { ...options, global: !options.global });
  const absent = pickRemovals(other.removals, missing).missing;
  const found = missing.filter((name) => !absent.includes(name)).map(displayLine);
  if (found.length > 0) {
    lines.push(options.global ? `Installed in the project: ${found.join(", ")} (leave out -g)` : `Installed globally: ${found.join(", ")} (add -g)`);
  }
  return new CliError(lines.join("\n"));
}

async function chooseRemovals(
  removals: Removal[],
  options: RemoveOptions,
  environment: AgentEnvironment,
  ui: Ui,
  short: Short,
): Promise<Cancellable<Removal[]>> {
  if (options.skills.length > 0) {
    const { picked, missing } = pickRemovals(removals, options.skills);
    if (missing.length > 0) throw await notInstalled(missing, removals, environment, options);
    return picked;
  }
  if (options.all) return removals;
  const chosen = await ui.selectInstalled(removals.map((removal) => ({ name: displayLine(removal.name), path: short(removal.path) })));
  return chosen === CANCELLED ? CANCELLED : removals.filter((_, index) => chosen.includes(index));
}

function summary(removals: Removal[], vetting: Vetting, short: Short): string {
  const line = (entry: InstalledEntry) => {
    const place = vetting.located.get(entry.path);
    const away = place === undefined ? "" : ` → ${short(place)}${vetting.outside.has(entry.path) ? " (outside the project)" : ""}`;
    return `  ${short(entry.path)}${entry.linked ? " (link)" : ""}${away}`;
  };
  return removals.map((removal) => [displayLine(removal.name), ...removal.entries.map(line)].join("\n")).join("\n\n");
}

async function removeEntries(removals: Removal[], short: Short): Promise<{ removed: Removal[]; failures: string[] }> {
  const removed: Removal[] = [];
  const failures: string[] = [];
  for (const removal of removals) {
    const before = failures.length;
    let linkFailed = false;
    for (const entry of removal.entries) {
      if (linkFailed && !entry.linked) {
        failures.push(`✗ ${short(entry.path)}: kept, because a link to it could not be removed`);
        continue;
      }
      try {
        await rm(entry.path, { recursive: true, force: true });
      } catch (err) {
        failures.push(`✗ ${short(entry.path)}: ${displayLine((err instanceof Error && err.message) || String(err))}`);
        if (entry.linked) linkFailed = true;
      }
    }
    if (failures.length === before) removed.push(removal);
  }
  return { removed, failures };
}

function report(removed: Removal[], failures: string[], ui: Ui): void {
  if (removed.length > 0) ui.note(removed.map((removal) => `✓ ${displayLine(removal.name)}`).join("\n"), `Removed ${plural(removed.length, "skill")}`);
  if (failures.length > 0) ui.error([`Failed to remove ${plural(failures.length, "path")}`, ...failures].join("\n"));
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
  const { removals, problems } = await findRemovals(environment, options);
  for (const problem of problems) ui.warn(displayLine(problem));
  if (options.skills.length === 0 && removals.length === 0) {
    ui.outro(`No ${options.global ? "global" : "project"} skills to remove`);
    return 0;
  }
  const chosen = await chooseRemovals(removals, options, environment, ui, short);
  if (chosen === CANCELLED) return cancelled(ui);

  const vetting = await vetRemovals(chosen, environment, { global: options.global, yes });
  if (vetting.refusals.length > 0) throw new CliError(["Nothing was removed:", ...vetting.refusals.map(displayLine)].join("\n"));
  ui.note(summary(chosen, vetting, short), "Removal Summary");
  if (!yes) {
    const proceed = await ui.confirm(`Remove ${plural(chosen.length, "skill")}?`);
    if (proceed === CANCELLED || !proceed) return cancelled(ui);
  }

  const { removed, failures } = await removeEntries(chosen, short);
  report(removed, failures, ui);
  ui.outro("Done!");
  return failures.length > 0 ? 1 : 0;
}
