import type { AddOptions } from "./add.js";
import { CliError } from "./errors.js";

export const USAGE = `Usage: skillsgist add <url> [options]

Install Agent Skills from a skillsgist registry. The URL and its install key are never stored.

Options:
  -g, --global            Install into your home directory instead of the project
  -a, --agent <ids...>    Agents to install to ('*' for all)
  -s, --skill <names...>  Skills to install ('*' for all)
  -y, --yes               Skip all prompts
      --copy              Copy into each agent directory instead of symlinking
      --all               Same as -s '*' -a '*' -y
  -l, --list              List the registry's skills without installing
  -h, --help              Show this help
  -v, --version           Show the version
`;

export type Command = { kind: "help" } | { kind: "version" } | { kind: "add"; url: string; options: AddOptions };

const ADD_COMMANDS = new Set(["add", "a", "install", "i"]);
const LOOKS_LIKE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

export function parseCommandLine(argv: string[]): Command {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help") return { kind: "help" };
  if (command === "-v" || command === "--version") return { kind: "version" };
  if (!ADD_COMMANDS.has(command)) throw new CliError(`Unknown command: ${command}`, { showUsage: true });
  const options: AddOptions = { global: false, agents: null, skills: null, yes: false, copy: false, list: false };
  let url: string | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
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
      case "-h":
      case "--help":
        return { kind: "help" };
      case "-a":
      case "--agent":
      case "-s":
      case "--skill": {
        const values: string[] = [];
        while (i + 1 < rest.length && !rest[i + 1].startsWith("-") && !LOOKS_LIKE_URL.test(rest[i + 1])) {
          values.push(rest[i + 1]);
          i += 1;
        }
        if (values.length === 0) throw new CliError(`${arg} needs at least one value`, { showUsage: true });
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
