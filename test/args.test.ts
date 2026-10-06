import { describe, expect, it } from "vitest";
import { parseCommandLine } from "../src/args.js";

function add(...argv: string[]) {
  const command = parseCommandLine(argv);
  if (command.kind !== "add") throw new Error(`expected add, got ${command.kind}`);
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

  it("reads the flags npx skills users type", () => {
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
    expect(failure(() => parseCommandLine(["remove", "x"]))).toBe("Unknown command: remove");
    expect(failure(() => parseCommandLine(["add", "https://h.example", "--full-depth"]))).toBe("Unknown option: --full-depth");
  });

  it("needs exactly one URL", () => {
    expect(failure(() => parseCommandLine(["add"]))).toBe("Missing the registry URL");
    expect(failure(() => parseCommandLine(["add", "https://a.example", "https://b.example"]))).toBe("Only one URL can be given");
  });

  it("needs a value after -a and -s", () => {
    expect(failure(() => parseCommandLine(["add", "https://h.example", "-a"]))).toBe("-a needs at least one value");
  });
});
