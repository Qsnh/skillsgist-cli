import { lstat, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { CANONICAL_SKILLS_DIR, type Agent } from "./agents.js";
import type { SkillFiles } from "./archive.js";
import { CliError } from "./errors.js";

export interface InstallOptions {
  global: boolean;
  copy: boolean;
  confirmed: boolean;
  home: string;
  cwd: string;
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
  return resolve(target).startsWith(resolve(base) + sep);
}

function inside(base: string, name: string): string {
  const target = join(base, sanitizeName(name));
  if (!isInside(base, target)) throw new CliError(`Refusing to install ${name} outside ${base}`);
  return target;
}

export function canonicalSkillDir(name: string, options: InstallOptions): string {
  return inside(join(options.global ? options.home : options.cwd, CANONICAL_SKILLS_DIR), name);
}

export function agentSkillDir(agent: Agent, name: string, options: InstallOptions): string | null {
  if (options.global && agent.globalDir === null) return null;
  if (agent.canonical) return canonicalSkillDir(name, options);
  return inside(options.global ? (agent.globalDir as string) : join(options.cwd, agent.skillsDir), name);
}

function holdsProjectFiles(agent: Agent | null): boolean {
  return agent !== null && !agent.skillsDir.startsWith(".");
}

async function located(path: string): Promise<string> {
  const parent = dirname(path);
  const real = await realpath(parent).catch(() => null);
  if (real !== null) return join(real, basename(path));
  return parent === path ? path : join(await located(parent), basename(path));
}

async function refusal(dir: string, agent: Agent | null, canonicalPath: string, options: InstallOptions): Promise<string | null> {
  if (options.global || options.confirmed) return null;
  const real = await located(dir);
  const shown = `.${sep}${relative(options.cwd, dir)}`;
  if (!isInside(await realpath(options.cwd), real)) {
    return `${shown} leads out of the project to ${real}; install from a terminal without -y to confirm`;
  }
  if (!holdsProjectFiles(agent)) return null;
  const existing = await lstat(dir).catch(() => null);
  if (existing === null || existing.isSymbolicLink() || real === (await located(canonicalPath))) return null;
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
  const existing = await lstat(linkPath).catch(() => null);
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

export async function installSkill(name: string, files: SkillFiles, agents: Agent[], options: InstallOptions): Promise<SkillResult> {
  const canonicalPath = canonicalSkillDir(name, options);
  const results: AgentResult[] = [];
  const guarded = async (dir: string, agent: Agent | null, action: () => Promise<void>) =>
    (await refusal(dir, agent, canonicalPath, options)) ?? (await attempt(action));
  if (options.copy) {
    const written = new Map<string, string | null>();
    for (const agent of agents) {
      const dir = agentSkillDir(agent, name, options);
      if (dir === null) {
        results.push(unsupported(agent));
        continue;
      }
      if (!written.has(dir)) written.set(dir, await guarded(dir, agent, () => writeSkill(dir, files)));
      const error = written.get(dir) ?? null;
      results.push(error !== null ? { agent, status: "failed", path: dir, error } : { agent, status: "copied", path: dir });
    }
    return { name, canonicalPath, agents: results };
  }
  const canonicalError = await guarded(canonicalPath, null, () => writeSkill(canonicalPath, files));
  for (const agent of agents) {
    const dir = agentSkillDir(agent, name, options);
    if (dir === null) {
      results.push(unsupported(agent));
      continue;
    }
    const error = canonicalError ?? (dir === canonicalPath ? null : await refusal(dir, agent, canonicalPath, options));
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

function targetDirs(name: string, agents: Agent[], options: InstallOptions): Map<string, Agent | null> {
  const dirs = new Map<string, Agent | null>(options.copy ? [] : [[canonicalSkillDir(name, options), null]]);
  for (const agent of agents) {
    const dir = agentSkillDir(agent, name, options);
    if (dir !== null && !dirs.has(dir)) dirs.set(dir, agent);
  }
  return dirs;
}

export async function replacedDirs(name: string, agents: Agent[], options: InstallOptions): Promise<string[]> {
  const canonicalPath = canonicalSkillDir(name, options);
  const target = options.copy ? null : await realpath(canonicalPath).catch(() => null);
  const found: string[] = [];
  for (const [dir, agent] of targetDirs(name, agents, options)) {
    if ((await lstat(dir).catch(() => null)) === null) continue;
    if (dir !== canonicalPath && target !== null && (await realpath(dir).catch(() => null)) === target) continue;
    if ((await refusal(dir, agent, canonicalPath, options)) !== null) continue;
    found.push(dir);
  }
  return found;
}

export async function outsideDirs(name: string, agents: Agent[], options: InstallOptions): Promise<Array<[string, string]>> {
  if (options.global) return [];
  const root = await realpath(options.cwd);
  const found: Array<[string, string]> = [];
  for (const dir of targetDirs(name, agents, options).keys()) {
    const real = await located(dir);
    if (!isInside(root, real)) found.push([dir, real]);
  }
  return found;
}
