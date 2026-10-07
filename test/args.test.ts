import { describe, expect, it } from "vitest";
import { parseCommandLine, USAGE } from "../src/args.js";
import { CliError } from "../src/errors.js";

function add(...argv: string[]) {
  const command = parseCommandLine(argv);
  if (command.kind !== "add") throw new Error(`expected add, got ${command.kind}`);
  return command;
}

function list(...argv: string[]) {
  const command = parseCommandLine(argv);
  if (command.kind !== "list") throw new Error(`expected list, got ${command.kind}`);
  return command;
}

function remove(...argv: string[]) {
  const command = parseCommandLine(argv);
  if (command.kind !== "remove") throw new Error(`expected remove, got ${command.kind}`);
  return command;
}

function failure(action: () => unknown): string {
  try {
    action();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a failure");
}

describe("parseCommandLine", () => {
  it.each(["add", "a", "install", "i"])("accepts the %s command", (name) => {
    expect(add(name, "https://h.example").url).toBe("https://h.example");
  });

  it("reads the boolean flags in short and long form", () => {
    expect(add("add", "https://h.example", "-g", "-y", "--copy", "-l").options).toEqual({
      global: true,
      agents: null,
      skills: null,
      yes: true,
      copy: true,
      list: true,
    });
    expect(add("add", "--global", "--yes", "--list", "https://h.example").options).toMatchObject({ global: true, yes: true, list: true });
  });

  it("collects agent and skill values up to the next option", () => {
    const { options } = add("add", "https://h.example", "-a", "claude-code", "cursor", "-s", "demo-skill", "--skill", "other-skill", "-y");
    expect(options.agents).toEqual(["claude-code", "cursor"]);
    expect(options.skills).toEqual(["demo-skill", "other-skill"]);
    expect(options.yes).toBe(true);
  });

  it("stops collecting values at the registry URL", () => {
    const command = add("add", "-s", "demo-skill", "https://h.example/i/key", "-a", "cursor", "-y");
    expect(command.url).toBe("https://h.example/i/key");
    expect(command.options).toMatchObject({ skills: ["demo-skill"], agents: ["cursor"], yes: true });
    expect(add("add", "-a", "cursor", "http://localhost:8787").url).toBe("http://localhost:8787");
    expect(failure(() => parseCommandLine(["add", "-s", "demo-skill", "https://a.example", "-a", "cursor", "https://b.example"]))).toBe(
      "Only one URL can be given",
    );
  });

  it("expands --all", () => {
    expect(add("add", "https://h.example", "--all").options).toMatchObject({ skills: ["*"], agents: ["*"], yes: true });
  });

  it("shows help and the version", () => {
    expect(parseCommandLine([])).toEqual({ kind: "help" });
    expect(parseCommandLine(["--help"])).toEqual({ kind: "help" });
    expect(parseCommandLine(["add", "-h"])).toEqual({ kind: "help" });
    expect(parseCommandLine(["-v"])).toEqual({ kind: "version" });
    expect(parseCommandLine(["--version"])).toEqual({ kind: "version" });
    expect(parseCommandLine(["add", "https://h.example", "-v"])).toEqual({ kind: "version" });
    expect(parseCommandLine(["add", "https://h.example", "--version"])).toEqual({ kind: "version" });
  });

  it("rejects unknown commands and options", () => {
    expect(failure(() => parseCommandLine(["wipe", "x"]))).toBe("Unknown command: wipe");
    expect(failure(() => parseCommandLine(["add", "https://h.example", "--full-depth"]))).toBe("Unknown option: --full-depth");
  });

  it("needs exactly one URL", () => {
    expect(failure(() => parseCommandLine(["add"]))).toBe("Missing the registry URL");
    expect(failure(() => parseCommandLine(["add", "https://a.example", "https://b.example"]))).toBe("Only one URL can be given");
  });

  it("needs a value after -a and -s", () => {
    expect(failure(() => parseCommandLine(["add", "https://h.example", "-a"]))).toBe("-a needs at least one value");
  });

  it("reads the agents command, which takes no arguments", () => {
    expect(parseCommandLine(["agents"])).toEqual({ kind: "agents" });
    expect(parseCommandLine(["agents", "-h"])).toEqual({ kind: "help" });
    expect(parseCommandLine(["agents", "--version"])).toEqual({ kind: "version" });
    expect(failure(() => parseCommandLine(["agents", "claude-code"]))).toBe("Unexpected argument: claude-code");
    expect(failure(() => parseCommandLine(["agents", "--json"]))).toBe("Unknown option for agents: --json");
    expect(failure(() => parseCommandLine(["agents", "-g"]))).toBe("Unknown option for agents: -g");
  });

  it("documents the agents command, and lists add's options under add", () => {
    expect(USAGE.split("\n")[0]).toBe("Usage: skillsgist add <url> [options]");
    expect(USAGE).toContain("skillsgist agents");
    const [, addOptions, shared] = USAGE.split(/^Options for add:$|^Options:$/m);
    expect(addOptions).toContain("-g, --global");
    expect(addOptions).toContain("-l, --list");
    expect(shared.trim().split("\n").map((line) => line.trim().split(/ {2,}/)[0])).toEqual(["-h, --help", "-v, --version"]);
  });

  it.each(["list", "ls"])("accepts the %s command with defaults", (name) => {
    expect(list(name).options).toEqual({ global: false, project: false, agents: null, json: false });
  });

  it("reads the flags for list", () => {
    expect(list("list", "-g", "-p", "--json").options).toEqual({
      global: true,
      project: true,
      agents: null,
      json: true,
    });
    expect(list("list", "--global", "--project").options).toMatchObject({ global: true, project: true });
  });

  it("collects agent values for list up to the next option", () => {
    expect(list("list", "-a", "claude-code", "codex", "-a", "cursor").options.agents).toEqual([
      "claude-code",
      "codex",
      "cursor",
    ]);
    expect(list("list", "-a", "claude-code", "-g").options).toMatchObject({ agents: ["claude-code"], global: true });
  });

  it("needs a value after -a for list", () => {
    expect(failure(() => parseCommandLine(["list", "-a"]))).toBe("-a needs at least one value");
  });

  it("shows help and the version for list", () => {
    expect(parseCommandLine(["list", "-h"])).toEqual({ kind: "help" });
    expect(parseCommandLine(["ls", "--version"])).toEqual({ kind: "version" });
  });

  it("rejects unknown options and unexpected arguments for list", () => {
    expect(failure(() => parseCommandLine(["list", "--yes"]))).toBe("Unknown option for list: --yes");
    expect(failure(() => parseCommandLine(["list", "foo"]))).toBe("Unexpected argument: foo");
  });

  it("marks list failures as CliErrors that show usage", () => {
    expect.assertions(4);
    try {
      parseCommandLine(["list", "--yes"]);
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).showUsage).toBe(true);
    }
    try {
      parseCommandLine(["list", "foo"]);
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).showUsage).toBe(true);
    }
  });

  it("documents the list command and lists list's options under list", () => {
    expect(USAGE.split("\n").slice(0, 4)).toEqual([
      "Usage: skillsgist add <url> [options]",
      "       skillsgist list [options]",
      "       skillsgist remove [skills...] [options]",
      "       skillsgist agents",
    ]);
    expect(USAGE).toContain("  list                    List installed skills (also: ls)");
    expect(USAGE).toContain(
      [
        "Options for list:",
        "  -g, --global            Only list skills in your home directory",
        "  -p, --project           Only list skills in the current directory",
        "  -a, --agent <ids...>    Only list skills installed for these agents ('*' for all)",
        "      --json              Print the list as JSON",
      ].join("\n"),
    );
  });

  it.each(["remove", "rm", "r"])("accepts the %s command with defaults", (name) => {
    expect(remove(name).options).toEqual({ global: false, agents: null, skills: [], all: false, yes: false });
  });

  it("reads the flags for remove", () => {
    expect(remove("rm", "demo-skill", "other", "-g", "-y").options).toEqual({
      global: true,
      agents: null,
      skills: ["demo-skill", "other"],
      all: false,
      yes: true,
    });
    const { options } = remove("remove", "a", "-s", "b", "c", "-a", "claude-code", "codex", "-s", "d");
    expect(options.skills).toEqual(["a", "b", "c", "d"]);
    expect(options.agents).toEqual(["claude-code", "codex"]);
  });

  it("reads a skill name after -a's agent ids as a skill to remove", () => {
    expect(remove("remove", "-a", "claude-code", "my-skill").options).toMatchObject({ agents: ["claude-code"], skills: ["my-skill"] });
    expect(remove("remove", "-a", "claude-code", "codex", "*", "my-skill", "other").options).toMatchObject({
      agents: ["claude-code", "codex", "*"],
      skills: ["my-skill", "other"],
    });
    expect(remove("remove", "-a", "nope", "my-skill").options).toMatchObject({ agents: ["nope"], skills: ["my-skill"] });
    expect(remove("remove", "-s", "my-skill", "codex").options).toMatchObject({ agents: null, skills: ["my-skill", "codex"] });
  });

  it("expands --all and '*' for remove", () => {
    expect(remove("remove", "--all").options).toEqual({ global: false, agents: null, skills: [], all: true, yes: true });
    expect(remove("remove", "*").options).toMatchObject({ all: true, yes: false, skills: [] });
    expect(remove("remove", "-s", "*").options).toMatchObject({ all: true, yes: false, skills: [] });
  });

  it("rejects combining --all or '*' with skill names for remove", () => {
    expect(failure(() => parseCommandLine(["remove", "--all", "demo-skill"]))).toBe("Cannot combine --all or '*' with skill names");
    expect(failure(() => parseCommandLine(["remove", "*", "demo-skill"]))).toBe("Cannot combine --all or '*' with skill names");
    expect(failure(() => parseCommandLine(["remove", "-a"]))).toBe("-a needs at least one value");
    expect(failure(() => parseCommandLine(["remove", "--copy"]))).toBe("Unknown option for remove: --copy");
  });

  it("marks remove failures as CliErrors that show usage", () => {
    const cases = [
      ["remove", "--all", "demo-skill"],
      ["remove", "*", "demo-skill"],
      ["remove", "-a"],
      ["remove", "--copy"],
    ];
    expect.assertions(cases.length * 2);
    for (const argv of cases) {
      try {
        parseCommandLine(argv);
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).showUsage).toBe(true);
      }
    }
  });

  it("shows help and the version for remove", () => {
    expect(parseCommandLine(["remove", "-h"])).toEqual({ kind: "help" });
    expect(parseCommandLine(["rm", "--version"])).toEqual({ kind: "version" });
  });

  it("documents the remove command and lists remove's options under remove", () => {
    expect(USAGE).toContain("  remove [skills...]      Remove installed skills (also: rm, r)");
    expect(USAGE).toContain(
      [
        "Options for remove:",
        "  -g, --global            Remove from your home directory instead of the project",
        "  -a, --agent <ids...>    Only remove from these agents' directories ('*' for all)",
        "  -s, --skill <names...>  Skills to remove ('*' for all)",
        "  -y, --yes               Skip all prompts",
        "      --all               Same as -s '*' -y",
      ].join("\n"),
    );
  });

  it("reads login with its URL and --no-browser", () => {
    expect(parseCommandLine(["login", "https://h.example/p/team"])).toEqual({ kind: "login", url: "https://h.example/p/team", options: { browser: true } });
    expect(parseCommandLine(["login", "--no-browser", "https://h.example"])).toEqual({ kind: "login", url: "https://h.example", options: { browser: false } });
    expect(failure(() => parseCommandLine(["login"]))).toBe("Missing the registry URL");
    expect(failure(() => parseCommandLine(["login", "https://a.example", "https://b.example"]))).toBe("Only one URL can be given");
    expect(failure(() => parseCommandLine(["login", "https://a.example", "-y"]))).toBe("Unknown option for login: -y");
    expect(parseCommandLine(["login", "-h"])).toEqual({ kind: "help" });
  });

  it.each(["logout", "whoami"] as const)("reads %s with an optional URL", (kind) => {
    expect(parseCommandLine([kind])).toEqual({ kind, url: null });
    expect(parseCommandLine([kind, "https://h.example"])).toEqual({ kind, url: "https://h.example" });
    expect(failure(() => parseCommandLine([kind, "https://a.example", "https://b.example"]))).toBe("Only one URL can be given");
    expect(failure(() => parseCommandLine([kind, "--all"]))).toBe(`Unknown option for ${kind}: --all`);
  });

  it("documents login, logout, whoami and the environment", () => {
    expect(USAGE.split("\n").slice(0, 7)).toEqual([
      "Usage: skillsgist add <url> [options]",
      "       skillsgist list [options]",
      "       skillsgist remove [skills...] [options]",
      "       skillsgist agents",
      "       skillsgist login <url> [--no-browser]",
      "       skillsgist logout [url]",
      "       skillsgist whoami [url]",
    ]);
    expect(USAGE).toContain("  login <url>             Sign in to a registry in your browser and choose its projects");
    expect(USAGE).toContain("  SKILLSGIST_HOST         The registry the install key belongs to; it is sent nowhere else");
    expect(USAGE).toContain(["Options for login:", "      --no-browser        Print the sign-in link without opening a browser"].join("\n"));
    expect(USAGE).not.toMatch(/never stored/);
  });
});
