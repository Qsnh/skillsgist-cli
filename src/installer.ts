import type { Stats } from "node:fs";
import { lstat, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { canonicalSkillsRoot, projectOwnedRoots, skillsRoot, type Agent } from "./agents.js";
import type { SkillFiles } from "./archive.js";
import { CliError, errorMessage } from "./errors.js";
import { isInside } from "./paths.js";

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

export interface ProjectGuard {
  outside(path: string): Promise<string | null>;
  owned(path: string): Promise<boolean>;
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

export function projectGuard(cwd: string, where: Locator): ProjectGuard {
  const root = where.real(cwd);
  const owned = Promise.all(projectOwnedRoots(cwd).map((dir) => where.real(dir))).then((dirs) => new Set(dirs));
  return {
    async outside(path) {
      const place = await where.located(path);
      return isInside(await root, place) ? null : place;
    },
    async owned(path) {
      return (await owned).has(dirname(await where.located(path)));
    },
  };
}

const entry = (path: string): Promise<Stats | null> => lstat(path).catch(() => null);

type Refusal = (dir: string, existing?: Stats | null) => Promise<string | null>;

function refuser(canonicalPath: string, options: InstallOptions, where: Locator): Refusal {
  if (options.global || options.confirmed) return async () => null;
  const guard = projectGuard(options.cwd, where);
  return async (dir, existing) => {
    const shown = `.${sep}${relative(options.cwd, dir)}`;
    const away = await guard.outside(dir);
    if (away !== null) return `${shown} leads out of the project to ${away}; install from a terminal without -y to confirm`;
    if (!(await guard.owned(dir))) return null;
    const found = existing === undefined ? await entry(dir) : existing;
    if (found === null || found.isSymbolicLink() || (await where.located(dir)) === (await where.located(canonicalPath))) return null;
    return `${shown} already exists and is not a link; remove it, or install from a terminal without -y to replace it`;
  };
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
    return errorMessage(err);
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
  const refusal = refuser(canonicalPath, options, where);
  const guarded = async (dir: string, action: () => Promise<void>) => (await refusal(dir)) ?? (await attempt(action));
  if (options.copy) {
    const written = new Map<string, string | null>();
    for (const [agent, dir] of targets) {
      if (!written.has(dir)) written.set(dir, await guarded(dir, () => writeSkill(dir, files)));
      const error = written.get(dir) ?? null;
      results.push(error !== null ? { agent, status: "failed", path: dir, error } : { agent, status: "copied", path: dir });
    }
    return { name, canonicalPath, agents: results };
  }
  const canonicalError = await guarded(canonicalPath, () => writeSkill(canonicalPath, files));
  for (const [agent, dir] of targets) {
    const error = canonicalError ?? (dir === canonicalPath ? null : await refusal(dir));
    if (error !== null) {
      results.push({ agent, status: "failed", path: dir, error });
    } else if (dir === canonicalPath) {
      results.push({ agent, status: "canonical", path: dir });
    } else if ((await attempt(() => linkSkill(canonicalPath, dir))) === null) {
      results.push({ agent, status: "symlinked", path: dir });
    } else {
      const copyError = await attempt(() => writeSkill(dir, files));
      results.push(copyError !== null ? { agent, status: "failed", path: dir, error: copyError } : { agent, status: "copied", path: dir });
    }
  }
  return { name, canonicalPath, agents: results };
}

function targetDirs(name: string, agents: Agent[], options: InstallOptions): string[] {
  const dirs = new Set<string>(options.copy ? [] : [canonicalSkillDir(name, options)]);
  for (const agent of agents) {
    const dir = agentSkillDir(agent, name, options);
    if (dir !== null) dirs.add(dir);
  }
  return [...dirs];
}

export async function replacedDirs(name: string, agents: Agent[], options: InstallOptions, where: Locator = locator()): Promise<string[]> {
  const canonicalPath = canonicalSkillDir(name, options);
  const dirs = targetDirs(name, agents, options);
  const refusal = refuser(canonicalPath, options, where);
  const replaced = await Promise.all(
    dirs.map(async (dir) => {
      const existing = await entry(dir);
      if (existing === null) return false;
      if (!options.copy && dir !== canonicalPath && (await where.real(dir)) === (await where.real(canonicalPath))) return false;
      return (await refusal(dir, existing)) === null;
    }),
  );
  return dirs.filter((_, index) => replaced[index]);
}

export async function outsideDirs(name: string, agents: Agent[], options: InstallOptions, where: Locator = locator()): Promise<Array<[string, string]>> {
  if (options.global) return [];
  const guard = projectGuard(options.cwd, where);
  const found = await Promise.all(targetDirs(name, agents, options).map(async (dir): Promise<[string, string | null]> => [dir, await guard.outside(dir)]));
  return found.filter((pair): pair is [string, string] => pair[1] !== null);
}
