import { sep } from "node:path";
import { agentDisplayName, detectRunningAgent, loadAgents, type Agent, type Exists, type RunningAgent } from "./agents.js";
import { unpackSkill, type SkillFiles } from "./archive.js";
import { CliError } from "./errors.js";
import {
  canonicalSkillDir,
  installSkill,
  outsideDirs,
  replacedDirs,
  type AgentResult,
  type InstallOptions,
  type InstalledAgent,
  type SkillResult,
} from "./installer.js";
import { downloadArtifact, fetchIndex, type FetchOptions, type SkillEntry } from "./registry.js";
import { parseSource } from "./source.js";

export const CANCELLED: unique symbol = Symbol("cancelled");

export type Cancellable<T> = T | typeof CANCELLED;

export interface AgentRequest {
  choices: Agent[];
  initial: string[];
  locked: Agent[];
}

export interface Ui {
  intro(title: string): void;
  step(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  message(message: string): void;
  note(body: string, title: string): void;
  cancel(message: string): void;
  outro(message: string): void;
  selectSkills(skills: SkillEntry[]): Promise<Cancellable<SkillEntry[]>>;
  selectAgents(request: AgentRequest): Promise<Cancellable<string[]>>;
  selectScope(): Promise<Cancellable<boolean>>;
  confirm(message: string): Promise<Cancellable<boolean>>;
}

export interface AddOptions {
  global: boolean;
  agents: string[] | null;
  skills: string[] | null;
  yes: boolean;
  copy: boolean;
  list: boolean;
}

export interface AddContext {
  ui: Ui;
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  exists?: Exists;
  fetch?: FetchOptions;
}

export const DEFAULT_AGENTS = ["claude-code", "opencode", "codex"];

const DOWNLOAD_CONCURRENCY = 4;

interface Payload {
  name: string;
  files: SkillFiles;
}

interface Selection {
  agents: Agent[];
  implied: Set<Agent>;
}

const unique = <T>(items: T[]): T[] => [...new Set(items)];

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function formatList(items: string[], max = 5): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} +${items.length - max} more`;
}

export function shortPath(path: string, home: string, cwd: string): string {
  if (path === home || path.startsWith(home + sep)) return `~${path.slice(home.length)}`;
  if (path === cwd || path.startsWith(cwd + sep)) return `.${path.slice(cwd.length)}`;
  return path;
}

function cancelled(ui: Ui): number {
  ui.cancel("Installation cancelled");
  return 0;
}

function sharedNames(agents: Agent[]): string[] {
  return agents.filter((agent) => agent.canonical && !agent.hidden).map((agent) => agent.displayName);
}

async function chooseSkills(all: SkillEntry[], options: AddOptions, yes: boolean, ui: Ui): Promise<Cancellable<SkillEntry[]>> {
  if (options.skills?.includes("*")) return all;
  if (options.skills) {
    const wanted = unique(options.skills.map((name) => name.toLowerCase()));
    const missing = wanted.filter((name) => !all.some((skill) => skill.name === name));
    if (missing.length > 0) {
      throw new CliError(`No skill named ${missing.join(", ")} in this registry. Available: ${all.map((skill) => skill.name).join(", ")}`);
    }
    return all.filter((skill) => wanted.includes(skill.name));
  }
  if (all.length === 1 || yes) return all;
  return ui.selectSkills(all);
}

async function chooseAgents(agents: Agent[], options: AddOptions, yes: boolean, running: RunningAgent, ui: Ui): Promise<Cancellable<Selection>> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const pick = (ids: string[]) => unique(ids).map((id) => byId.get(id) as Agent);
  const universal = agents.filter((agent) => agent.universal);
  const select = (picked: Agent[], extra: Agent[] = []): Selection => {
    const implied = extra.filter((agent) => !picked.includes(agent));
    return { agents: [...picked, ...implied], implied: new Set(implied) };
  };
  if (options.agents?.includes("*")) return select([], agents);
  if (options.agents) {
    const invalid = options.agents.filter((id) => !byId.has(id));
    if (invalid.length > 0) {
      throw new CliError(`Invalid agents: ${invalid.join(", ")}. Valid agents: ${agents.map((agent) => agent.id).join(", ")}`);
    }
    return select(pick(options.agents));
  }
  const installed = agents.filter((agent) => agent.installed);
  if (running.inAgent) return select(running.id === null ? installed : pick([running.id]), universal);
  if (installed.length === 0) {
    if (yes) return select([], universal);
    const chosen = await ui.selectAgents({ choices: agents.filter((agent) => agent.pickable), initial: DEFAULT_AGENTS, locked: [] });
    return chosen === CANCELLED ? CANCELLED : select(pick(chosen));
  }
  if (installed.length === 1 || yes) return select(installed, universal);
  const choices = agents.filter((agent) => !agent.canonical && agent.pickable);
  const chosen = await ui.selectAgents({
    choices,
    initial: installed.filter((agent) => choices.includes(agent)).map((agent) => agent.id),
    locked: universal.filter((agent) => !agent.hidden),
  });
  return chosen === CANCELLED ? CANCELLED : select(pick(chosen), universal);
}

async function chooseScope(targets: Agent[], options: AddOptions, yes: boolean, ui: Ui): Promise<Cancellable<boolean>> {
  if (options.global) return true;
  if (yes || !targets.some((agent) => agent.globalDir !== null)) return false;
  return ui.selectScope();
}

function forScope(selection: Selection, global: boolean, options: AddOptions, ui: Ui): Agent[] {
  if (!global) return selection.agents;
  const chosen = selection.agents.filter((agent) => agent.globalDir === null && !selection.implied.has(agent));
  const names = chosen.map((agent) => agent.displayName).join(", ");
  if (chosen.length > 0 && options.agents !== null) throw new CliError(`${names} cannot install skills globally`);
  const supported = selection.agents.filter((agent) => agent.globalDir !== null);
  if (supported.length === 0) throw new CliError("None of the selected agents can install skills globally");
  if (chosen.length > 0) ui.warn(`Skipping ${names}: no global skills directory`);
  return supported;
}

async function summary(skills: SkillEntry[], targets: Agent[], install: InstallOptions): Promise<string> {
  const short = (path: string) => shortPath(path, install.home, install.cwd);
  const everyone = formatList(targets.map((agent) => agent.displayName));
  const shared = formatList(sharedNames(targets));
  const linked = formatList(targets.filter((agent) => !agent.canonical).map((agent) => agent.displayName));
  const blocks: string[] = [];
  for (const skill of skills) {
    const lines: string[] = [];
    if (install.copy) {
      lines.push(`${skill.name} (copy)`);
      lines.push(`  copy → ${everyone}`);
    } else {
      lines.push(short(canonicalSkillDir(skill.name, install)));
      if (shared !== "") lines.push(`  universal: ${shared}`);
      if (linked !== "") lines.push(`  symlink → ${linked}`);
    }
    const replaced = await replacedDirs(skill.name, targets, install);
    if (replaced.length > 0) lines.push(`  overwrites: ${formatList(replaced.map(short))}`);
    for (const [dir, real] of await outsideDirs(skill.name, targets, install)) lines.push(`  outside the project: ${short(dir)} → ${short(real)}`);
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

async function downloadAll(skills: SkillEntry[], options: FetchOptions = {}): Promise<Payload[]> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const payloads: Payload[] = [];
  let next = 0;
  const worker = async () => {
    while (next < skills.length && !signal.aborted) {
      const position = next;
      next += 1;
      const skill = skills[position];
      const bytes = await downloadArtifact(skill, { ...options, signal });
      payloads[position] = { name: skill.name, files: unpackSkill(skill.name, bytes) };
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, skills.length) }, worker));
  } catch (err) {
    controller.abort();
    throw err;
  }
  return payloads;
}

function isInstalled(result: AgentResult): result is InstalledAgent {
  return result.status !== "failed";
}

function report(results: SkillResult[], install: InstallOptions, ui: Ui): void {
  const lines: string[] = [];
  const fallbacks: string[] = [];
  const failures: string[] = [];
  let installed = 0;
  for (const result of results) {
    for (const agent of result.agents) {
      if (agent.status === "failed") failures.push(`✗ ${result.name} → ${agent.agent.displayName}: ${agent.error}`);
    }
    const done = result.agents.filter(isInstalled);
    if (done.length === 0) continue;
    installed += 1;
    if (install.copy) {
      lines.push(`✓ ${result.name} (copied)`);
      for (const path of unique(done.map((agent) => shortPath(agent.path, install.home, install.cwd)))) lines.push(`  → ${path}`);
      continue;
    }
    lines.push(`✓ ${shortPath(result.canonicalPath, install.home, install.cwd)}`);
    const shared = sharedNames(done.filter((agent) => agent.status === "canonical").map((agent) => agent.agent));
    const linked = done.filter((agent) => agent.status === "symlinked").map((agent) => agent.agent.displayName);
    const copied = done.filter((agent) => agent.status === "copied").map((agent) => agent.agent.displayName);
    if (shared.length > 0) lines.push(`  universal: ${formatList(shared)}`);
    if (linked.length > 0) lines.push(`  symlinked: ${formatList(linked)}`);
    if (copied.length > 0) {
      lines.push(`  copied: ${formatList(copied)}`);
      fallbacks.push(...copied);
    }
  }
  if (installed > 0) ui.note(lines.join("\n"), `Installed ${plural(installed, "skill")}`);
  if (fallbacks.length > 0) ui.warn(`Symlinks failed for: ${formatList(unique(fallbacks))}. Files were copied instead.`);
  if (failures.length > 0) ui.error([`Failed to install ${failures.length}`, ...failures].join("\n"));
}

export async function runAdd(url: string, options: AddOptions, context: AddContext): Promise<number> {
  const { ui } = context;
  const source = parseSource(url);
  const running = detectRunningAgent(context.env, context.exists);
  const yes = options.yes || running.inAgent;
  if (!options.list && !yes && !context.interactive) {
    throw new CliError("There is no terminal to ask questions in. Add -y to install without prompts.");
  }
  if (running.inAgent) {
    ui.info(`${agentDisplayName(running.id) ?? "An agent"} detected — installing non-interactively`);
  } else {
    ui.intro("skillsgist");
  }
  ui.step(`Source: ${source.display}`);

  const index = await fetchIndex(source, context.fetch);
  for (const warning of index?.warnings ?? []) ui.warn(warning);
  if (index === null || index.skills.length === 0) throw new CliError(`No skills found at ${source.display}`);
  ui.step(`Found ${plural(index.skills.length, "skill")}`);

  if (options.list) {
    ui.message(index.skills.map((skill) => `${skill.name}\n  ${skill.description}`).join("\n"));
    ui.outro("Run without --list to install");
    return 0;
  }

  const skills = await chooseSkills(index.skills, options, yes, ui);
  if (skills === CANCELLED) return cancelled(ui);
  const agents = loadAgents({ home: context.home, cwd: context.cwd, env: context.env, exists: context.exists });
  const chosen = await chooseAgents(agents, options, yes, running, ui);
  if (chosen === CANCELLED) return cancelled(ui);
  const global = await chooseScope(chosen.agents, options, yes, ui);
  if (global === CANCELLED) return cancelled(ui);
  const targets = forScope(chosen, global, options, ui);
  const install: InstallOptions = { global, copy: options.copy, confirmed: !yes, home: context.home, cwd: context.cwd };

  ui.note(await summary(skills, targets, install), "Installation Summary");
  if (!yes) {
    const proceed = await ui.confirm("Proceed with installation?");
    if (proceed === CANCELLED || !proceed) return cancelled(ui);
  }

  const payloads = await downloadAll(skills, context.fetch);

  const results: SkillResult[] = [];
  for (const payload of payloads) results.push(await installSkill(payload.name, payload.files, targets, install));
  report(results, install, ui);
  ui.outro("Done!  Review skills before use; they run with full agent permissions.");
  return results.some((result) => result.agents.some((agent) => agent.status === "failed")) ? 1 : 0;
}
