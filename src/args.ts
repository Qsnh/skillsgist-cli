import type { AddOptions } from "./add.js";
import { CliError } from "./errors.js";
import type { ListOptions } from "./list-skills.js";
import type { RemoveOptions } from "./remove.js";

export const USAGE = `Usage: skillsgist add <url> [options]
       skillsgist list [options]
       skillsgist remove [skills...] [options]
       skillsgist agents

Install Agent Skills from a skillsgist registry. The URL and its install key are never stored.

Commands:
  add <url>               Install skills from the registry at <url> (also: a, install, i)
  list                    List installed skills (also: ls)
  remove [skills...]      Remove installed skills (also: rm, r)
  agents                  List the agents -a accepts and where add installs for each

Options for add:
  -g, --global            Install into your home directory instead of the project
  -a, --agent <ids...>    Agents to install to ('*' for all)
  -s, --skill <names...>  Skills to install ('*' for all)
  -y, --yes               Skip all prompts
      --copy              Copy into each agent directory instead of symlinking
      --all               Same as -s '*' -a '*' -y
  -l, --list              List the registry's skills without installing

Options for list:
  -g, --global            Only list skills in your home directory
  -p, --project           Only list skills in the current directory
  -a, --agent <ids...>    Only list skills installed for these agents ('*' for all)
      --json              Print the list as JSON

Options for remove:
  -g, --global            Remove from your home directory instead of the project
  -a, --agent <ids...>    Only remove from these agents' directories ('*' for all)
  -s, --skill <names...>  Skills to remove ('*' for all)
  -y, --yes               Skip all prompts
      --all               Same as -s '*' -y

Options:
  -h, --help              Show this help
  -v, --version           Show the version
`;

export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "agents" }
  | { kind: "add"; url: string; options: AddOptions }
  | { kind: "list"; options: ListOptions }
  | { kind: "remove"; options: RemoveOptions };

const ADD_COMMANDS = new Set(["add", "a", "install", "i"]);
const LIST_COMMANDS = new Set(["list", "ls"]);
const REMOVE_COMMANDS = new Set(["remove", "rm", "r"]);
const LOOKS_LIKE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

function helpOrVersion(arg: string): Command | null {
  if (arg === "-h" || arg === "--help") return { kind: "help" };
  if (arg === "-v" || arg === "--version") return { kind: "version" };
  return null;
}

function valuesAfter(rest: string[], i: number): string[] {
  const values: string[] = [];
  for (let next = i + 1; next < rest.length && !rest[next].startsWith("-") && !LOOKS_LIKE_URL.test(rest[next]); next += 1) values.push(rest[next]);
  if (values.length === 0) throw new CliError(`${rest[i]} needs at least one value`, { showUsage: true });
  return values;
}

function parseAgents(rest: string[]): Command {
  const [arg] = rest;
  if (arg === undefined) return { kind: "agents" };
  const early = helpOrVersion(arg);
  if (early !== null) return early;
  if (arg.startsWith("-")) throw new CliError(`Unknown option for agents: ${arg}`, { showUsage: true });
  throw new CliError(`Unexpected argument: ${arg}`, { showUsage: true });
}

function parseList(rest: string[]): Command {
  const options: ListOptions = { global: false, project: false, agents: null, json: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const early = helpOrVersion(arg);
    if (early !== null) return early;
    switch (arg) {
      case "-g":
      case "--global":
        options.global = true;
        break;
      case "-p":
      case "--project":
        options.project = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "-a":
      case "--agent": {
        const values = valuesAfter(rest, i);
        i += values.length;
        options.agents = [...(options.agents ?? []), ...values];
        break;
      }
      default:
        if (arg.startsWith("-")) throw new CliError(`Unknown option for list: ${arg}`, { showUsage: true });
        throw new CliError(`Unexpected argument: ${arg}`, { showUsage: true });
    }
  }
  return { kind: "list", options };
}

function parseRemove(rest: string[]): Command {
  const options: RemoveOptions = { global: false, agents: null, skills: [], all: false, yes: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const early = helpOrVersion(arg);
    if (early !== null) return early;
    switch (arg) {
      case "-g":
      case "--global":
        options.global = true;
        break;
      case "-y":
      case "--yes":
        options.yes = true;
        break;
      case "--all":
        options.all = true;
        options.yes = true;
        break;
      case "-a":
      case "--agent":
      case "-s":
      case "--skill": {
        const values = valuesAfter(rest, i);
        i += values.length;
        if (arg === "-a" || arg === "--agent") options.agents = [...(options.agents ?? []), ...values];
        else options.skills.push(...values);
        break;
      }
      default:
        if (arg.startsWith("-")) throw new CliError(`Unknown option for remove: ${arg}`, { showUsage: true });
        options.skills.push(arg);
    }
  }
  if (options.skills.includes("*")) {
    options.skills = options.skills.filter((name) => name !== "*");
    options.all = true;
  }
  if (options.all && options.skills.length > 0) throw new CliError("Cannot combine --all or '*' with skill names", { showUsage: true });
  return { kind: "remove", options };
}

export function parseCommandLine(argv: string[]): Command {
  const [command, ...rest] = argv;
  if (command === undefined) return { kind: "help" };
  const early = helpOrVersion(command);
  if (early !== null) return early;
  if (command === "agents") return parseAgents(rest);
  if (LIST_COMMANDS.has(command)) return parseList(rest);
  if (REMOVE_COMMANDS.has(command)) return parseRemove(rest);
  if (!ADD_COMMANDS.has(command)) throw new CliError(`Unknown command: ${command}`, { showUsage: true });
  const options: AddOptions = { global: false, agents: null, skills: null, yes: false, copy: false, list: false };
  let url: string | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const early = helpOrVersion(arg);
    if (early !== null) return early;
    switch (arg) {
      case "-g":
      case "--global":
        options.global = true;
        break;
      case "-y":
      case "--yes":
        options.yes = true;
        break;
      case "--copy":
        options.copy = true;
        break;
      case "-l":
      case "--list":
        options.list = true;
        break;
      case "--all":
        options.skills = ["*"];
        options.agents = ["*"];
        options.yes = true;
        break;
      case "-a":
      case "--agent":
      case "-s":
      case "--skill": {
        const values = valuesAfter(rest, i);
        i += values.length;
        if (arg === "-a" || arg === "--agent") options.agents = [...(options.agents ?? []), ...values];
        else options.skills = [...(options.skills ?? []), ...values];
        break;
      }
      default:
        if (arg.startsWith("-")) throw new CliError(`Unknown option: ${arg}`, { showUsage: true });
        if (url !== null) throw new CliError("Only one URL can be given", { showUsage: true });
        url = arg;
    }
  }
  if (url === null) throw new CliError("Missing the registry URL", { showUsage: true });
  return { kind: "add", url, options };
}
