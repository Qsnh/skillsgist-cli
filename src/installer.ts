import type { Stats } from "node:fs";
import { lstat, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { canonicalSkillsRoot, skillsRoot, type Agent } from "./agents.js";
import { trimFrontmatter, type SkillFiles } from "./archive.js";
import { CliError } from "./errors.js";
import { within } from "./paths.js";

export interface InstallOptions {
  global: boolean;
  copy: boolean;
  confirmed: boolean;
  home: string;
  cwd: string;
}

export interface Locator {
  real(dir: string): Promise<string>;
  located(path: string): Promise<string>;
}

export interface InstalledAgent {
  agent: Agent;
  status: "canonical" | "symlinked" | "copied";
  path: string;
}

export interface FailedAgent {
  agent: Agent;
  status: "failed";
  path: string | null;
  error: string;
}

export type AgentResult = InstalledAgent | FailedAgent;

export interface SkillResult {
  name: string;
  canonicalPath: string;
  agents: AgentResult[];
}

export function sanitizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 255) || "unnamed-skill"
  );
}

function isInside(base: string, target: string): boolean {
  const rest = within(base, target);
  return rest !== null && rest !== "";
}

function inside(base: string, name: string): string {
  const target = join(base, sanitizeName(name));
  if (!isInside(base, target)) throw new CliError(`Refusing to install ${name} outside ${base}`);
  return target;
}

export function canonicalSkillDir(name: string, options: InstallOptions): string {
  return inside(canonicalSkillsRoot(options), name);
}

export function agentSkillDir(agent: Agent, name: string, options: InstallOptions): string | null {
  const root = skillsRoot(agent, options);
  return root === null ? null : inside(root, name);
}

export function locator(): Locator {
  const dirs = new Map<string, Promise<string>>();
  const real = (dir: string): Promise<string> => {
    let found = dirs.get(dir);
    if (found === undefined) {
      found = realpath(dir).catch(() => (dirname(dir) === dir ? dir : located(dir)));
      dirs.set(dir, found);
    }
    return found;
  };
  const located = async (path: string) => join(await real(dirname(path)), basename(path));
  return { real, located };
}

const entry = (path: string): Promise<Stats | null> => lstat(path).catch(() => null);

async function refusal(
  dir: string,
  agent: Agent | null,
  canonicalPath: string,
  options: InstallOptions,
  where: Locator,
  existing?: Stats | null,
): Promise<string | null> {
  if (options.global || options.confirmed) return null;
  const real = await where.located(dir);
  const shown = `.${sep}${relative(options.cwd, dir)}`;
  if (!isInside(await where.real(options.cwd), real)) {
    return `${shown} leads out of the project to ${real}; install from a terminal without -y to confirm`;
  }
  if (!agent?.projectOwned) return null;
  const found = existing === undefined ? await entry(dir) : existing;
  if (found === null || found.isSymbolicLink() || real === (await where.located(canonicalPath))) return null;
  return `${shown} already exists and is not a link; remove it, or install from a terminal without -y to replace it`;
}

async function writeSkill(dir: string, files: SkillFiles): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [path, data] of files) {
    const target = join(dir, path);
    if (!isInside(dir, target)) throw new Error(`refusing to write ${path} outside the skill directory`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

async function linkSkill(canonicalPath: string, linkPath: string): Promise<void> {
  await mkdir(dirname(linkPath), { recursive: true });
  const target = await realpath(canonicalPath);
  const link = join(await realpath(dirname(linkPath)), basename(linkPath));
  if (link === target) return;
  const existing = await entry(linkPath);
  if (existing?.isSymbolicLink() && (await realpath(linkPath).catch(() => null)) === target) return;
  if (existing) await rm(linkPath, { recursive: true, force: true });
  if (process.platform === "win32") await symlink(target, linkPath, "junction");
  else await symlink(relative(dirname(link), target), linkPath);
}

async function attempt(action: () => Promise<void>): Promise<string | null> {
  try {
    await action();
    return null;
  } catch (err) {
    return (err instanceof Error && err.message) || String(err);
  }
}

function unsupported(agent: Agent): FailedAgent {
  return { agent, status: "failed", path: null, error: `${agent.displayName} does not support global skill installation` };
}

export async function installSkill(
  name: string,
  files: SkillFiles,
  agents: Agent[],
  options: InstallOptions,
  where: Locator = locator(),
): Promise<SkillResult> {
  const canonicalPath = canonicalSkillDir(name, options);
  const results: AgentResult[] = [];
  const targets: Array<[Agent, string]> = [];
  for (const agent of agents) {
    const dir = agentSkillDir(agent, name, options);
    if (dir === null) results.push(unsupported(agent));
    else targets.push([agent, dir]);
  }
  const guarded = async (dir: string, agent: Agent | null, action: () => Promise<void>) =>
    (await refusal(dir, agent, canonicalPath, options, where)) ?? (await attempt(action));
  const filesFor = (agent: Agent) => (agent.ownCopy ? trimFrontmatter(files) : files);
  if (options.copy) {
    const written = new Map<string, string | null>();
    for (const [agent, dir] of targets) {
      if (!written.has(dir)) written.set(dir, await guarded(dir, agent, () => writeSkill(dir, filesFor(agent))));
      const error = written.get(dir) ?? null;
      results.push(error !== null ? { agent, status: "failed", path: dir, error } : { agent, status: "copied", path: dir });
    }
    return { name, canonicalPath, agents: results };
  }
  const linkable = async (agent: Agent, dir: string) =>
    !agent.ownCopy || (await where.located(dir)) === (await where.located(canonicalPath));
  const canonicalError = await guarded(canonicalPath, null, () => writeSkill(canonicalPath, files));
  for (const [agent, dir] of targets) {
    const error = canonicalError ?? (dir === canonicalPath ? null : await refusal(dir, agent, canonicalPath, options, where));
    if (error !== null) {
      results.push({ agent, status: "failed", path: dir, error });
    } else if (dir === canonicalPath) {
      results.push({ agent, status: "canonical", path: dir });
    } else if ((await linkable(agent, dir)) && (await attempt(() => linkSkill(canonicalPath, dir))) === null) {
      results.push({ agent, status: "symlinked", path: dir });
    } else {
      const copyError = await attempt(() => writeSkill(dir, filesFor(agent)));
      results.push(copyError !== null ? { agent, status: "failed", path: dir, error: copyError } : { agent, status: "copied", path: dir });
    }
  }
  return { name, canonicalPath, agents: results };
}

function targetDirs(name: string, agents: Agent[], options: InstallOptions): Map<string, Agent | null> {
  const dirs = new Map<string, Agent | null>(options.copy ? [] : [[canonicalSkillDir(name, options), null]]);
  for (const agent of agents) {
    const dir = agentSkillDir(agent, name, options);
    if (dir !== null && !dirs.has(dir)) dirs.set(dir, agent);
  }
  return dirs;
}

export async function replacedDirs(name: string, agents: Agent[], options: InstallOptions, where: Locator = locator()): Promise<string[]> {
  const canonicalPath = canonicalSkillDir(name, options);
  const dirs = [...targetDirs(name, agents, options)];
  const replaced = await Promise.all(
    dirs.map(async ([dir, agent]) => {
      const existing = await entry(dir);
      if (existing === null) return false;
      if (!options.copy && dir !== canonicalPath && (await where.real(dir)) === (await where.real(canonicalPath))) return false;
      return (await refusal(dir, agent, canonicalPath, options, where, existing)) === null;
    }),
  );
  return dirs.filter((_, index) => replaced[index]).map(([dir]) => dir);
}

export async function outsideDirs(name: string, agents: Agent[], options: InstallOptions, where: Locator = locator()): Promise<Array<[string, string]>> {
  if (options.global) return [];
  const root = await where.real(options.cwd);
  const dirs = [...targetDirs(name, agents, options).keys()];
  const found = await Promise.all(dirs.map(async (dir): Promise<[string, string]> => [dir, await where.located(dir)]));
  return found.filter(([, real]) => !isInside(root, real));
}
