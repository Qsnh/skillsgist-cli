import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, filesContaining, tempDir } from "./helpers/fs.js";
import { KEY, publishIndex, skillZip, startRegistry, type TestRegistry } from "./helpers/registry.js";

const CLI = resolve("dist/cli.js");
const RECORDER = pathToFileURL(resolve("test/fixtures/record-connections.mjs")).href;

interface Sandbox {
  home: string;
  cwd: string;
  log: string;
}

interface Result {
  code: number;
  output: string;
  stdout: string;
  stderr: string;
  connections: string[];
}

interface TreeEntry {
  type: "file" | "dir" | "link";
  size: number;
  mtimeMs: number;
  target: string | null;
}

function treeSnapshot(root: string): Record<string, TreeEntry> {
  const out: Record<string, TreeEntry> = {};
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const info = lstatSync(path);
      out[rel] = {
        type: info.isSymbolicLink() ? "link" : info.isDirectory() ? "dir" : "file",
        size: info.size,
        mtimeMs: info.mtimeMs,
        target: info.isSymbolicLink() ? readlinkSync(path) : null,
      };
      if (info.isDirectory()) walk(path, rel);
    }
  };
  if (existsSync(root)) walk(root, "");
  return out;
}

function sandboxSnapshot(box: Sandbox): { home: Record<string, TreeEntry>; cwd: Record<string, TreeEntry> } {
  return { home: treeSnapshot(box.home), cwd: treeSnapshot(box.cwd) };
}

let registry: TestRegistry;

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error("dist/cli.js is missing: run npm run build first");
  registry = await startRegistry();
  const demo = { name: "demo-skill", zip: skillZip("demo-skill", { "references/api.md": "api", "scripts/run.sh": "echo run" }) };
  publishIndex(registry, `/i/${KEY}`, [demo, { name: "other-skill", zip: skillZip("other-skill") }]);
  publishIndex(registry, `/i/${KEY}/.well-known/agent-skills/demo-skill`, [demo]);
});

afterAll(() => registry.close());
afterEach(cleanup);

function sandbox(): Sandbox {
  const root = tempDir();
  const box = { home: join(root, "home"), cwd: join(root, "project"), log: join(root, "connections.log") };
  mkdirSync(box.home);
  mkdirSync(box.cwd);
  return box;
}

function run(box: Sandbox, args: string[], env: Record<string, string> = {}): Promise<Result> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      ["--import", RECORDER, CLI, ...args],
      {
        cwd: box.cwd,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: box.home,
          USERPROFILE: box.home,
          XDG_CONFIG_HOME: join(box.home, ".config"),
          CONNECTION_LOG: box.log,
          ...env,
        },
      },
      (error, stdout, stderr) => {
        const connections = existsSync(box.log) ? readFileSync(box.log, "utf8").split("\n").filter(Boolean) : [];
        done({ code: error ? Number(error.code ?? 1) : 0, output: `${stdout}${stderr}`, stdout, stderr, connections });
      },
    );
  });
}

function expectNoLeak(box: Sandbox, result: Result): void {
  expect(result.output).not.toContain(KEY);
  expect(filesContaining(box.home, KEY)).toEqual([]);
  expect(filesContaining(box.cwd, KEY)).toEqual([]);
  const registryHost = new URL(registry.origin).host;
  expect(result.connections.filter((connection) => connection !== registryHost)).toEqual([]);
}

describe("skillsgist add", () => {
  it("runs the skillsgist agent prompt inside Claude Code without leaving the key behind", async () => {
    const box = sandbox();
    const result = await run(
      box,
      ["add", `${registry.origin}/i/${KEY}/.well-known/agent-skills/demo-skill`, "--skill", "demo-skill", "-g", "-y"],
      { CLAUDECODE: "1", AI_AGENT: "claude-code_2-1-280_harness" },
    );
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/✓ ~\/\.agents\/skills\/demo-skill\b/);
    expect(result.output).toContain("/i/0123…");
    expect(existsSync(join(box.home, ".agents/skills/demo-skill/references/api.md"))).toBe(true);
    expect(lstatSync(join(box.home, ".claude/skills/demo-skill")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(box.home, ".claude/skills/demo-skill/SKILL.md"), "utf8")).toContain("name: demo-skill");
    expect(readdirSync(box.cwd)).toEqual([]);
    expect(result.connections.length).toBeGreaterThan(0);
    expectNoLeak(box, result);
  });

  it("installs every skill of a key into the project with -y", async () => {
    const box = sandbox();
    const result = await run(box, ["add", `${registry.origin}/i/${KEY}`, "-y"]);
    expect(result.code).toBe(0);
    expect(readdirSync(join(box.cwd, ".agents/skills")).sort()).toEqual(["demo-skill", "other-skill"]);
    expect(readdirSync(box.home)).toEqual([]);
    expectNoLeak(box, result);
  });

  it("copies with --copy", async () => {
    const box = sandbox();
    const result = await run(box, ["add", `${registry.origin}/i/${KEY}`, "-s", "demo-skill", "-a", "claude-code", "--copy", "-y"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("✓ demo-skill (copied)");
    expect(lstatSync(join(box.cwd, ".claude/skills/demo-skill")).isDirectory()).toBe(true);
    expectNoLeak(box, result);
  });

  it("lists skills without writing anything", async () => {
    const box = sandbox();
    const result = await run(box, ["add", `${registry.origin}/i/${KEY}`, "--list"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("other-skill");
    expect(readdirSync(box.cwd)).toEqual([]);
    expect(readdirSync(box.home)).toEqual([]);
    expectNoLeak(box, result);
  });

  it("writes nothing when an artifact fails its digest check", async () => {
    const box = sandbox();
    publishIndex(registry, "/tampered", [{ name: "demo-skill", zip: skillZip("demo-skill") }]);
    for (const [path, route] of registry.routes) {
      if (path.startsWith("/tampered/d/")) route.body = skillZip("demo-skill", { "evil.md": "x" });
    }
    const result = await run(box, ["add", `${registry.origin}/tampered`, "-y"]);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/sha256/);
    expect(readdirSync(box.cwd)).toEqual([]);
    expectNoLeak(box, result);
  });

  it("skips an index entry on another origin and never contacts it", async () => {
    const box = sandbox();
    publishIndex(registry, "/mixed", [{ name: "demo-skill", zip: skillZip("demo-skill") }], {
      overrides: [{ name: "far-skill", description: "Far.", type: "archive", url: "https://far.example/far.zip", digest: `sha256:${"0".repeat(64)}` }],
    });
    const result = await run(box, ["add", `${registry.origin}/mixed`, "-y"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("Skipped index entry far-skill: url points to another origin");
    expectNoLeak(box, result);
  });

  it("refuses plain http to a remote host before connecting anywhere", async () => {
    const box = sandbox();
    const result = await run(box, ["add", `http://skills.example.com/i/${KEY}`, "-y"]);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/use https/);
    expect(result.connections).toEqual([]);
    expectNoLeak(box, result);
  });

  it("prints the usage for an unknown option", async () => {
    const box = sandbox();
    const result = await run(box, ["add", `${registry.origin}/i/${KEY}`, "--full-depth"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown option: --full-depth");
    expect(result.stderr).toContain("Usage: skillsgist add <url> [options]");
  });
});

describe("the skillsgist binary", () => {
  // npm chmods a bin only when it creates the link in node_modules/.bin, and
  // npx rebuilds a local checkout through prepare on every run, so dist/cli.js
  // has to come out of the build executable.
  it.skipIf(process.platform === "win32")("runs directly, through its shebang", async () => {
    const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    const stdout = await new Promise<string>((done, fail) => {
      execFile(CLI, ["--version"], (error, out) => (error ? fail(error) : done(out)));
    });
    expect(stdout).toBe(`${version}\n`);
  });
});

describe("skillsgist agents", () => {
  it("lists the agents without touching the network or the disk", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".claude"));
    const result = await run(box, ["agents"]);
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/^73 agents\. /);
    expect(result.output).toMatch(/^✓ {2}claude-code +Claude Code +\.claude\/skills +~\/\.claude\/skills$/m);
    expect(result.output).toMatch(/^ {3}amp +Amp +\.agents\/skills +~\/\.agents\/skills$/m);
    expect(result.output).not.toContain("\x1b");
    expect(result.connections).toEqual([]);
    expect(readdirSync(box.home)).toEqual([".claude"]);
    expect(readdirSync(box.cwd)).toEqual([]);
  });

  it("says what add installs for inside an agent, above the same list", async () => {
    const box = sandbox();
    const note = "Inside Claude Code, `skillsgist add <url>` without -a installs for claude-code and the agents that read .agents/skills, whatever is ticked.\n";
    const plain = await run(box, ["agents"]);
    const inside = await run(box, ["agents"], { CLAUDECODE: "1" });
    expect(inside.code).toBe(0);
    expect(plain.output).not.toContain(note);
    expect(inside.output).toContain(note);
    expect(inside.output.replace(note, "")).toBe(plain.output);
  });

  it("ticks agents detected in the current directory", async () => {
    const box = sandbox();
    mkdirSync(join(box.cwd, "data/skills"), { recursive: true });
    const result = await run(box, ["agents"]);
    expect(result.output).toMatch(/^✓ {2}astrbot /m);
  });

  it("rejects an argument with the usage", async () => {
    const box = sandbox();
    const result = await run(box, ["agents", "claude-code"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unexpected argument: claude-code");
    expect(result.stderr).toContain("skillsgist agents");
  });
});

describe("skillsgist list", () => {
  it("lists what add just installed, without touching the network or the disk", async () => {
    const box = sandbox();
    const added = await run(box, ["add", `${registry.origin}/i/${KEY}`, "-y", "-a", "claude-code"]);
    expect(added.code).toBe(0);
    const before = sandboxSnapshot(box);
    const result = await run(box, ["list"]);
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/^demo-skill +\.\/\.agents\/skills\/demo-skill +Claude Code$/m);
    expect(result.output).toContain("other-skill");
    expect(result.connections).toEqual(added.connections);
    expect(result.output).not.toContain("\x1b");
    expect(result.output).not.toContain(KEY);
    expect(sandboxSnapshot(box)).toEqual(before);
  });

  it("prints JSON of project skills on stdout alone", async () => {
    const box = sandbox();
    const added = await run(box, ["add", `${registry.origin}/i/${KEY}`, "-y", "-a", "claude-code"]);
    expect(added.code).toBe(0);
    const result = await run(box, ["ls", "--json", "-p"]);
    expect(result.code).toBe(0);
    const rows = JSON.parse(result.stdout) as Array<{ name: string; scope: string }>;
    expect(rows.map((row) => row.name).sort()).toEqual(["demo-skill", "other-skill"]);
    for (const row of rows) expect(row.scope).toBe("project");
  });

  it("says nothing is installed in an empty sandbox", async () => {
    const box = sandbox();
    const result = await run(box, ["list"]);
    expect(result.code).toBe(0);
    expect(result.output).toBe("No project skills\n\nNo global skills\n");
  });

  it("rejects an unexpected argument and an invalid agent", async () => {
    const box = sandbox();
    const extra = await run(box, ["list", "extra"]);
    expect(extra.code).toBe(1);
    expect(extra.stderr).toContain("Unexpected argument: extra");
    expect(extra.stderr).toContain("Usage:");

    const invalidAgent = await run(box, ["list", "-a", "nope"]);
    expect(invalidAgent.code).toBe(1);
    expect(invalidAgent.output).toContain("Invalid agents: nope");
  });
});
