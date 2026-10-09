import { agentFilter, agentsById, detectRunningAgent, loadAgents, type Agent, type RunningAgent } from "./agents.js";
import { unpackSkill, type SkillFiles } from "./archive.js";
import { authHeaders, resolveCredential, type Credential } from "./auth.js";
import { CliError } from "./errors.js";
import { plural } from "./format.js";
import { AuthError } from "./http.js";
import {
  canonicalSkillDir,
  installSkill,
  locator,
  outsideDirs,
  replacedDirs,
  type AgentResult,
  type InstallOptions,
  type InstalledAgent,
  type Locator,
  type SkillResult,
} from "./installer.js";
import { configOf, hostOf, signIn, signInUrl, type AccountContext } from "./login.js";
import { shortPath } from "./paths.js";
import { downloadArtifact, fetchIndex, type FetchOptions, type Index, type SkillEntry } from "./registry.js";
import { parseSource, type Source } from "./source.js";

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
  selectInstalled(skills: Array<{ name: string; path: string }>): Promise<Cancellable<number[]>>;
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

export type AddContext = AccountContext;

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

function formatList(items: string[], max = 5): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} +${items.length - max} more`;
}

export function cancelled(ui: Ui, message = "Installation cancelled"): number {
  ui.cancel(message);
  return 0;
}

function sharedNames(agents: Agent[]): string[] {
  return agents.filter((agent) => agent.canonical && !agent.hidden).map((agent) => agent.displayName);
}

async function chooseSkills(all: SkillEntry[], options: AddOptions, yes: boolean, ui: Ui, hint: string): Promise<Cancellable<SkillEntry[]>> {
  if (options.skills) {
    const wanted = unique(options.skills.filter((name) => name !== "*").map((name) => name.toLowerCase()));
    const missing = wanted.filter((name) => !all.some((skill) => skill.name === name));
    if (missing.length > 0) {
      throw new CliError(`No skill named ${missing.join(", ")} in this registry. Available: ${all.map((skill) => skill.name).join(", ")}${hint}`);
    }
    return options.skills.includes("*") ? all : all.filter((skill) => wanted.includes(skill.name));
  }
  if (all.length === 1 || yes) return all;
  return ui.selectSkills(all);
}

async function chooseAgents(agents: Agent[], options: AddOptions, yes: boolean, running: RunningAgent, ui: Ui): Promise<Cancellable<Selection>> {
  const pick = (ids: string[]) => agentsById(agents, ids);
  const universal = agents.filter((agent) => agent.universal);
  const select = (picked: Agent[], extra: Agent[] = []): Selection => {
    const implied = extra.filter((agent) => !picked.includes(agent));
    return { agents: [...picked, ...implied], implied: new Set(implied) };
  };
  if (options.agents) {
    const filter = agentFilter(agents, options.agents);
    return filter.named ? select(filter.agents) : select([], filter.agents);
  }
  if (running.inAgent) return select(running.id === null ? [] : pick([running.id]), universal);
  const installed = agents.filter((agent) => agent.installed);
  if (installed.length === 0) {
    if (yes) return select([], universal);
    const chosen = await ui.selectAgents({ choices: agents, initial: DEFAULT_AGENTS, locked: [] });
    return chosen === CANCELLED ? CANCELLED : select(pick(chosen));
  }
  if (installed.length === 1 || yes) return select(installed, universal);
  const choices = agents.filter((agent) => !agent.canonical);
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

async function summary(skills: SkillEntry[], targets: Agent[], install: InstallOptions, where: Locator): Promise<string> {
  const short = (path: string) => shortPath(path, install.home, install.cwd);
  const names = (agents: Agent[]) => formatList(agents.map((agent) => agent.displayName));
  const everyone = names(targets);
  const shared = formatList(sharedNames(targets));
  const linked = names(targets.filter((agent) => !agent.canonical));
  const blocks = await Promise.all(
    skills.map(async (skill) => {
      const lines: string[] = [];
      if (install.copy) {
        lines.push(`${skill.name} (copy)`);
        lines.push(`  copy → ${everyone}`);
      } else {
        lines.push(short(canonicalSkillDir(skill.name, install)));
        if (shared !== "") lines.push(`  universal: ${shared}`);
        if (linked !== "") lines.push(`  symlink → ${linked}`);
      }
      const [replaced, outside] = await Promise.all([
        replacedDirs(skill.name, targets, install, where),
        outsideDirs(skill.name, targets, install, where),
      ]);
      if (replaced.length > 0) lines.push(`  overwrites: ${formatList(replaced.map(short))}`);
      for (const [dir, real] of outside) lines.push(`  outside the project: ${short(dir)} → ${short(real)}`);
      return lines.join("\n");
    }),
  );
  return blocks.join("\n\n");
}

async function downloadAll(skills: SkillEntry[], options: FetchOptions = {}): Promise<Payload[]> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const payloads: Payload[] = [];
  let next = 0;
  const worker = async () => {
    while (next < skills.length) {
      signal.throwIfAborted();
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

interface Loaded {
  index: Index | null;
  credential: Credential;
}

function loginCommand(source: Source): string {
  return `npx skillsgist login ${signInUrl(source)}`;
}

// Null when the credentials file cannot be read: add goes on without a sign-in, and must not
// offer one, since signing in would fail on the same file.
function credentialFor(source: Source, context: AddContext): Credential | null {
  try {
    return resolveCredential(source.origin, configOf(context));
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    context.ui.warn(`${err.message} Continuing without signing in.`);
    return null;
  }
}

function explain(err: AuthError, credential: Credential, source: Source): CliError {
  const host = hostOf(source.origin);
  if (credential.kind === "env" && err.status === 401) return new CliError(`SKILLSGIST_INSTALL_KEY was rejected by ${host}: it was reset or revoked`);
  if (credential.kind === "env" && err.code === "wrong_project") {
    return new CliError(
      `SKILLSGIST_INSTALL_KEY is for project ${err.project ?? "another project"}, not ${source.project ?? source.display}. ` +
        `Use the install key of project ${source.project ?? "this project"}, or unset SKILLSGIST_INSTALL_KEY to use your sign-in`,
    );
  }
  if (credential.kind === "login" && err.status === 401) return new CliError(`Your sign-in to ${host} has expired or was revoked. Run: ${loginCommand(source)}`);
  if (credential.kind === "login" && err.code === "project_not_granted") {
    const project = err.project ?? source.project ?? "";
    return new CliError(`Your sign-in to ${host} does not cover project ${project}. Run: npx skillsgist login ${source.origin}/p/${encodeURIComponent(project)}`);
  }
  if (credential.kind === "none") return new CliError(`${err.message}. Private skills need a sign-in: ${loginCommand(source)}`);
  return err;
}

async function offerSignIn(question: string, source: Source, context: AddContext, mayAsk: boolean): Promise<Credential | null> {
  if (!mayAsk || !context.interactive) return null;
  const answer = await context.ui.confirm(question);
  if (answer === CANCELLED || !answer) return null;
  const login = await signIn(source, context, { browser: true });
  return { kind: "login", token: login.token };
}

async function loadIndex(source: Source, context: AddContext, yes: boolean): Promise<Loaded> {
  const host = hostOf(source.origin);
  const saved = credentialFor(source, context);
  const mayAsk = !yes && saved !== null;
  let credential: Credential = saved ?? { kind: "none" };
  if (credential.kind === "none" && source.project !== null) {
    context.ui.info(`Public skills only. To include private ones, run: ${loginCommand(source)}`);
  }
  for (let retried = false; ; retried = true) {
    let index: Index | null;
    try {
      index = await fetchIndex(source, { ...context.fetch, headers: authHeaders(credential) });
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
      const fixable = !retried && credential.kind !== "env" && (err.status === 401 || err.code === "project_not_granted");
      const question =
        err.code === "project_not_granted"
          ? `Your sign-in does not cover project ${err.project ?? source.project}. Sign in again to add it?`
          : credential.kind === "none"
            ? `${host} asks you to sign in. Sign in now?`
            : `Your sign-in to ${host} has expired. Sign in again now?`;
      const next = fixable ? await offerSignIn(question, source, context, mayAsk) : null;
      if (next === null) throw explain(err, credential, source);
      credential = next;
      continue;
    }
    // A null index means neither index URL exists: the address is not a registry, so signing in would not help.
    if (index === null || index.skills.length > 0 || credential.kind !== "none" || retried) return { index, credential };
    const next = await offerSignIn(`No public skills at ${source.display}. Sign in to ${host} to see private ones?`, source, context, mayAsk);
    if (next === null) return { index, credential };
    credential = next;
  }
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
    ui.info(`${running.name ?? "An agent"} detected — installing non-interactively`);
  } else {
    ui.intro("skillsgist");
  }
  ui.step(`Source: ${source.display}`);

  const { index, credential } = await loadIndex(source, context, yes);
  for (const warning of index?.warnings ?? []) ui.warn(warning);
  const anonymous = credential.kind === "none";
  if (index === null || index.skills.length === 0) {
    const hint = anonymous ? `. If they are private, sign in first (${loginCommand(source)}) or set SKILLSGIST_HOST and SKILLSGIST_INSTALL_KEY` : "";
    throw new CliError(`No skills found at ${source.display}${hint}`);
  }
  ui.step(`Found ${plural(index.skills.length, "skill")}`);

  if (options.list) {
    ui.message(index.skills.map((skill) => `${skill.name}\n  ${skill.description}`).join("\n"));
    ui.outro("Run without --list to install");
    return 0;
  }

  const skills = await chooseSkills(index.skills, options, yes, ui, anonymous ? `. Private skills need a sign-in: ${loginCommand(source)}` : "");
  if (skills === CANCELLED) return cancelled(ui);
  const agents = loadAgents({ home: context.home, cwd: context.cwd, env: context.env, exists: context.exists });
  const chosen = await chooseAgents(agents, options, yes, running, ui);
  if (chosen === CANCELLED) return cancelled(ui);
  const global = await chooseScope(chosen.agents, options, yes, ui);
  if (global === CANCELLED) return cancelled(ui);
  const targets = forScope(chosen, global, options, ui);
  const install: InstallOptions = { global, copy: options.copy, confirmed: !yes, home: context.home, cwd: context.cwd };
  const where = locator();

  ui.note(await summary(skills, targets, install, where), "Installation Summary");
  if (!yes) {
    const proceed = await ui.confirm("Proceed with installation?");
    if (proceed === CANCELLED || !proceed) return cancelled(ui);
  }

  let payloads: Payload[];
  try {
    payloads = await downloadAll(skills, { ...context.fetch, headers: authHeaders(credential) });
  } catch (err) {
    throw err instanceof AuthError ? explain(err, credential, source) : err;
  }

  const results: SkillResult[] = [];
  for (const payload of payloads) results.push(await installSkill(payload.name, payload.files, targets, install, where));
  report(results, install, ui);
  ui.outro("Done!  Review skills before use; they run with full agent permissions.");
  return results.some((result) => result.agents.some((agent) => agent.status === "failed")) ? 1 : 0;
}
