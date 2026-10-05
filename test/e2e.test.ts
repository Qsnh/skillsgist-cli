import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
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
  connections: string[];
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
        done({ code: error ? Number(error.code ?? 1) : 0, output: `${stdout}${stderr}`, connections });
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
    expect(result.output).toContain("Unknown option: --full-depth");
    expect(result.output).toContain("Usage: skillsgist add <url> [options]");
  });
});
