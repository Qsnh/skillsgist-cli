import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CANCELLED, runAdd, type AddContext, type AddOptions, type AgentRequest, type Ui } from "../src/add.js";
import { saveLogin } from "../src/credentials.js";
import type { SkillEntry } from "../src/registry.js";
import { cleanup, filesContaining, sandboxExists, tempDir } from "./helpers/fs.js";
import { installFakeAuth } from "./helpers/oauth.js";
import { INSTALL_KEY, LOGIN_TOKEN, publishIndex, publishPrivate, skillZip, startRegistry, type TestRegistry } from "./helpers/registry.js";

type Answer<T> = T | typeof CANCELLED;

interface Answers {
  skills?: Answer<string[]>;
  agents?: Answer<string[]>;
  scope?: Answer<boolean>;
  selectInstalled?: Answer<number[]>;
  confirm?: Answer<boolean>;
}

function fakeUi(answers: Answers = {}) {
  const lines: string[] = [];
  const asked: string[] = [];
  const requests: AgentRequest[] = [];
  function answer<T>(name: keyof Answers): T {
    asked.push(name);
    if (!(name in answers)) throw new Error(`unexpected ${name} prompt`);
    return answers[name] as T;
  }
  const ui: Ui = {
    intro: (message) => lines.push(message),
    step: (message) => lines.push(message),
    info: (message) => lines.push(message),
    warn: (message) => lines.push(`warn: ${message}`),
    error: (message) => lines.push(`error: ${message}`),
    message: (message) => lines.push(message),
    note: (body, title) => lines.push(`${title}\n${body}`),
    cancel: (message) => lines.push(`cancel: ${message}`),
    outro: (message) => lines.push(message),
    selectSkills: async (skills: SkillEntry[]) => {
      const chosen = answer<Answer<string[]>>("skills");
      return chosen === CANCELLED ? chosen : skills.filter((skill) => chosen.includes(skill.name));
    },
    selectAgents: async (request: AgentRequest) => {
      requests.push(request);
      return answer<Answer<string[]>>("agents");
    },
    selectScope: async () => answer<Answer<boolean>>("scope"),
    selectInstalled: async () => answer<Answer<number[]>>("selectInstalled"),
    confirm: async () => answer<Answer<boolean>>("confirm"),
  };
  return { ui, asked, requests, text: () => lines.join("\n") };
}

const options = (overrides: Partial<AddOptions> = {}): AddOptions => ({
  global: false,
  agents: null,
  skills: null,
  yes: false,
  copy: false,
  list: false,
  ...overrides,
});

let registry: TestRegistry;
let url: string;

beforeAll(async () => {
  registry = await startRegistry();
  publishIndex(registry, `/p/team`, [
    { name: "demo-skill", zip: skillZip("demo-skill", { "references/api.md": "api" }) },
    { name: "other-skill", zip: skillZip("other-skill") },
  ]);
  publishPrivate(registry, "/p/secret", [{ name: "secret-skill", zip: skillZip("secret-skill") }], [LOGIN_TOKEN, INSTALL_KEY]);
  url = `${registry.origin}/p/team`;
});

afterAll(() => registry.close());
afterEach(cleanup);

function sandbox(env: NodeJS.ProcessEnv = {}, interactive = true) {
  const home = tempDir();
  const cwd = tempDir();
  const context = (ui: Ui): AddContext => ({ ui, home, cwd, env, interactive, exists: sandboxExists(home, cwd) });
  return { home, cwd, context };
}

describe("runAdd", () => {
  it("installs one skill globally for Claude Code without asking anything, like the agent prompt", async () => {
    const box = sandbox({ CLAUDECODE: "1" }, false);
    const ui = fakeUi();
    const code = await runAdd(url, options({ skills: ["demo-skill"], global: true, yes: true }), box.context(ui.ui));
    expect(code).toBe(0);
    expect(ui.asked).toEqual([]);
    expect(existsSync(join(box.home, ".agents/skills/demo-skill/references/api.md"))).toBe(true);
    expect(lstatSync(join(box.home, ".claude/skills/demo-skill")).isSymbolicLink()).toBe(true);
    expect(ui.text()).toContain("Claude Code detected");
    expect(ui.text()).toContain("✓ ~/.agents/skills/demo-skill");
    expect(ui.text()).toContain("universal: Amp, Antigravity, Antigravity CLI, Cline, Codex +8 more");
    expect(ui.text()).toContain("symlinked: Claude Code");
    expect(ui.text()).not.toContain("Failed");
    expect(ui.text()).not.toContain("Skipping");
    expect(readdirSync(box.cwd)).toEqual([]);
  });

  it("installs only into the universal directory inside an agent it does not know", async () => {
    const box = sandbox({ AI_AGENT: "v0" }, false);
    mkdirSync(join(box.home, ".claude"));
    mkdirSync(join(box.home, ".roo"));
    const ui = fakeUi();
    expect(await runAdd(url, options({ skills: ["demo-skill"], global: true, yes: true }), box.context(ui.ui))).toBe(0);
    expect(ui.asked).toEqual([]);
    expect(ui.text()).toContain("An agent detected");
    expect(existsSync(join(box.home, ".agents/skills/demo-skill/SKILL.md"))).toBe(true);
    expect(readdirSync(join(box.home, ".claude"))).toEqual([]);
    expect(readdirSync(join(box.home, ".roo"))).toEqual([]);
    expect(ui.text()).not.toContain("symlinked");
  });

  it("installs a project skill only into .agents/skills inside an agent it does not know", async () => {
    const box = sandbox({ AI_AGENT: "v0" }, false);
    mkdirSync(join(box.home, ".claude"));
    mkdirSync(join(box.home, ".openclaw"));
    const ui = fakeUi();
    expect(await runAdd(url, options({ skills: ["demo-skill"] }), box.context(ui.ui))).toBe(0);
    expect(readdirSync(box.cwd)).toEqual([".agents"]);
    expect(existsSync(join(box.cwd, ".agents/skills/demo-skill/SKILL.md"))).toBe(true);
  });

  it("names Devin when it finds Devin's marker file", async () => {
    const box = sandbox();
    const ui = fakeUi();
    const exists = sandboxExists(box.home, box.cwd);
    const context = { ...box.context(ui.ui), exists: (path: string) => path === "/opt/.devin" || exists(path) };
    expect(await runAdd(url, options({ skills: ["demo-skill"] }), context)).toBe(0);
    expect(ui.text()).toContain("Devin detected — installing non-interactively");
    expect(existsSync(join(box.cwd, ".agents/skills/demo-skill/SKILL.md"))).toBe(true);
  });

  it("lists skills without installing or needing a terminal", async () => {
    const box = sandbox({}, false);
    const ui = fakeUi();
    expect(await runAdd(url, options({ list: true }), box.context(ui.ui))).toBe(0);
    expect(ui.text()).toContain("demo-skill\n  The demo-skill skill.");
    expect(ui.text()).toContain("other-skill");
    expect(readdirSync(box.cwd)).toEqual([]);
    expect(readdirSync(box.home)).toEqual([]);
  });

  it("does not look for installed agents with --list", async () => {
    const box = sandbox({}, false);
    const looked: string[] = [];
    const context = { ...box.context(fakeUi().ui), exists: (path: string) => (looked.push(path), false) };
    expect(await runAdd(url, options({ list: true }), context)).toBe(0);
    expect(looked).toEqual(["/opt/.devin"]);
  });

  it("refuses to prompt without a terminal before asking the registry anything", async () => {
    const box = sandbox({}, false);
    const before = registry.requests.length;
    await expect(runAdd(url, options(), box.context(fakeUi().ui))).rejects.toThrow(/Add -y/);
    expect(registry.requests.length).toBe(before);
  });

  it("asks for skills, agents, scope and confirmation when no agent is detected", async () => {
    const box = sandbox();
    const ui = fakeUi({ skills: ["other-skill"], agents: ["claude-code"], scope: false, confirm: true });
    expect(await runAdd(url, options(), box.context(ui.ui))).toBe(0);
    expect(ui.asked).toEqual(["skills", "agents", "scope", "confirm"]);
    expect(ui.requests[0].initial).toEqual(["claude-code", "opencode", "codex"]);
    expect(ui.requests[0].locked).toEqual([]);
    expect(readlinkSync(join(box.cwd, ".claude/skills/other-skill"))).toBe("../../.agents/skills/other-skill");
    expect(ui.text()).toContain("✓ ./.agents/skills/other-skill");
  });

  it("locks the universal agents and preselects the detected ones when several agents are installed", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".claude"));
    mkdirSync(join(box.home, ".codeium/windsurf"), { recursive: true });
    const ui = fakeUi({ agents: ["windsurf"], scope: true, confirm: true });
    expect(await runAdd(url, options({ skills: ["demo-skill"] }), box.context(ui.ui))).toBe(0);
    const request = ui.requests[0];
    expect(request.initial).toEqual(["claude-code", "windsurf"]);
    expect(request.locked.map((agent) => agent.id)).toEqual([
      "amp", "antigravity", "antigravity-cli", "cline", "codex", "cursor", "deepagents",
      "gemini-cli", "github-copilot", "kimi-code-cli", "opencode", "warp", "zed",
    ]);
    expect(request.choices.some((agent) => agent.canonical)).toBe(false);
    expect(lstatSync(join(box.home, ".codeium/windsurf/skills/demo-skill")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(box.home, ".agents/skills/demo-skill/SKILL.md"))).toBe(true);
    expect(existsSync(join(box.home, ".claude/skills/demo-skill"))).toBe(false);
  });

  it("installs to the one detected agent and the universal directory with -y", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".claude"));
    const ui = fakeUi();
    expect(await runAdd(url, options({ skills: ["demo-skill"], yes: true }), box.context(ui.ui))).toBe(0);
    expect(ui.asked).toEqual([]);
    expect(lstatSync(join(box.cwd, ".claude/skills/demo-skill")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(box.cwd, ".agents/skills/demo-skill/SKILL.md"))).toBe(true);
  });

  it("installs only into .agents/skills when -y finds no agent", async () => {
    const box = sandbox();
    expect(await runAdd(url, options({ yes: true }), box.context(fakeUi().ui))).toBe(0);
    expect(readdirSync(box.cwd)).toEqual([".agents"]);
    expect(readdirSync(join(box.cwd, ".agents/skills")).sort()).toEqual(["demo-skill", "other-skill"]);
  });

  it("writes nothing and exits 0 when a prompt is cancelled", async () => {
    const box = sandbox();
    const ui = fakeUi({ skills: CANCELLED });
    expect(await runAdd(url, options(), box.context(ui.ui))).toBe(0);
    expect(ui.text()).toContain("cancel: Installation cancelled");
    expect(readdirSync(box.cwd)).toEqual([]);
  });

  it("writes nothing when the summary is declined", async () => {
    const box = sandbox();
    const ui = fakeUi({ agents: ["claude-code"], scope: false, confirm: false });
    expect(await runAdd(url, options({ skills: ["demo-skill"] }), box.context(ui.ui))).toBe(0);
    expect(readdirSync(box.cwd)).toEqual([]);
  });

  it("writes nothing when a download fails its digest check", async () => {
    const box = sandbox();
    publishIndex(registry, "/tampered", [{ name: "demo-skill", zip: skillZip("demo-skill") }]);
    for (const [path, route] of registry.routes) {
      if (path.startsWith("/tampered/d/")) route.body = skillZip("demo-skill", { "evil.md": "x" });
    }
    await expect(runAdd(`${registry.origin}/tampered`, options({ yes: true }), box.context(fakeUi().ui))).rejects.toThrow(/sha256/);
    expect(readdirSync(box.cwd)).toEqual([]);
    expect(readdirSync(box.home)).toEqual([]);
  });

  it("downloads the artifacts side by side and installs them in index order", async () => {
    const box = sandbox();
    const names = ["slow-one", "slow-two", "slow-three"];
    publishIndex(registry, "/slow", names.map((name) => ({ name, zip: skillZip(name) })));
    let arrived = 0;
    let allArrived!: () => void;
    const together = new Promise<void>((resolve) => (allArrived = resolve));
    const waitForAll = () => {
      arrived += 1;
      if (arrived === names.length) allArrived();
      return together;
    };
    for (const [path, route] of registry.routes) if (path.startsWith("/slow/d/")) route.waitFor = waitForAll;
    const ui = fakeUi();
    expect(await runAdd(`${registry.origin}/slow`, options({ yes: true }), box.context(ui.ui))).toBe(0);
    expect(ui.text()).toContain("✓ ./.agents/skills/slow-one\n  universal: Amp, Antigravity, Antigravity CLI, Cline, Codex +8 more\n✓ ./.agents/skills/slow-two");
    expect(readdirSync(join(box.cwd, ".agents/skills")).sort()).toEqual(["slow-one", "slow-three", "slow-two"]);
  });

  it("stops at the first failed download without waiting for the others", async () => {
    const box = sandbox();
    publishIndex(registry, "/stuck", [
      { name: "stuck-skill", zip: skillZip("stuck-skill") },
      { name: "broken-skill", zip: skillZip("broken-skill") },
    ]);
    for (const [path, route] of registry.routes) {
      if (path.startsWith("/stuck/d/stuck-skill/")) route.waitFor = () => new Promise(() => {});
      if (path.startsWith("/stuck/d/broken-skill/")) route.body = skillZip("broken-skill", { "evil.md": "x" });
    }
    await expect(runAdd(`${registry.origin}/stuck`, options({ yes: true }), box.context(fakeUi().ui))).rejects.toThrow(
      "broken-skill does not match its sha256 digest",
    );
    expect(readdirSync(box.cwd)).toEqual([]);
  });

  it("says which picked agents it skips in global scope", async () => {
    const box = sandbox();
    const ui = fakeUi({ agents: ["claude-code", "promptscript"], scope: true, confirm: true });
    expect(await runAdd(url, options({ skills: ["demo-skill"] }), box.context(ui.ui))).toBe(0);
    expect(ui.text()).toContain("warn: Skipping PromptScript: no global skills directory");
    expect(lstatSync(join(box.home, ".claude/skills/demo-skill")).isSymbolicLink()).toBe(true);
  });

  it("stops the downloads when the caller's signal aborts", async () => {
    const box = sandbox();
    publishIndex(registry, "/cancel", [{ name: "slow-skill", zip: skillZip("slow-skill") }]);
    const controller = new AbortController();
    for (const [path, route] of registry.routes) {
      if (path.startsWith("/cancel/d/")) route.waitFor = () => (controller.abort(), new Promise(() => {}));
    }
    const context = { ...box.context(fakeUi().ui), fetch: { signal: controller.signal } };
    await expect(runAdd(`${registry.origin}/cancel`, options({ yes: true }), context)).rejects.toThrow(/aborted/);
    expect(readdirSync(box.cwd)).toEqual([]);
  });

  it("installs nothing when the caller's signal aborts before the downloads start", async () => {
    const box = sandbox();
    const controller = new AbortController();
    const ui = fakeUi();
    const note = ui.ui.note;
    ui.ui.note = (body, title) => {
      note(body, title);
      if (title === "Installation Summary") controller.abort();
    };
    const context = { ...box.context(ui.ui), fetch: { signal: controller.signal } };
    await expect(runAdd(url, options({ yes: true }), context)).rejects.toThrow(/aborted/);
    expect(ui.text()).not.toContain("Done!");
    expect(readdirSync(box.cwd)).toEqual([]);
  });

  it("refuses a named agent that cannot install globally", async () => {
    const box = sandbox();
    await expect(
      runAdd(url, options({ agents: ["promptscript"], global: true, yes: true, skills: ["demo-skill"] }), box.context(fakeUi().ui)),
    ).rejects.toThrow(/PromptScript cannot install skills globally/);
  });

  it("reports a missing index", async () => {
    const box = sandbox();
    await expect(runAdd(`${registry.origin}/p/nobody`, options({ yes: true }), box.context(fakeUi().ui))).rejects.toThrow(
      `No skills found at ${registry.origin}/p/nobody`,
    );
  });

  it("matches -s names case-insensitively and names the missing ones", async () => {
    const box = sandbox();
    expect(await runAdd(url, options({ skills: ["Demo-Skill"], yes: true }), box.context(fakeUi().ui))).toBe(0);
    expect(existsSync(join(box.cwd, ".agents/skills/demo-skill/SKILL.md"))).toBe(true);
    await expect(runAdd(url, options({ skills: ["nope"], yes: true }), box.context(fakeUi().ui))).rejects.toThrow(
      "No skill named nope in this registry. Available: demo-skill, other-skill",
    );
    await expect(runAdd(url, options({ skills: ["*", "nope"], yes: true }), box.context(fakeUi().ui))).rejects.toThrow("No skill named nope");
  });

  it("rejects an unknown agent id, even next to '*'", async () => {
    const box = sandbox();
    await expect(runAdd(url, options({ agents: ["nope"], yes: true }), box.context(fakeUi().ui))).rejects.toThrow(/Invalid agents: nope/);
    await expect(runAdd(url, options({ agents: ["*", "nope"], yes: true }), box.context(fakeUi().ui))).rejects.toThrow(/Invalid agents: nope/);
    expect(readdirSync(box.cwd)).toEqual([]);
  });

  it("survives running the same install twice and reports only the copy it replaces", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".claude"));
    const first = fakeUi();
    expect(await runAdd(url, options({ skills: ["demo-skill"], yes: true }), box.context(first.ui))).toBe(0);
    expect(first.text()).not.toContain("overwrites:");
    const second = fakeUi();
    expect(await runAdd(url, options({ skills: ["demo-skill"], yes: true }), box.context(second.ui))).toBe(0);
    expect(second.text()).toContain("symlink → Claude Code\n  overwrites: ./.agents/skills/demo-skill\n");
    expect(existsSync(join(box.cwd, ".claude/skills/demo-skill/SKILL.md"))).toBe(true);
  });

  it("reports an agent directory that holds its own copy", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".claude"));
    mkdirSync(join(box.cwd, ".claude/skills/demo-skill"), { recursive: true });
    const ui = fakeUi();
    expect(await runAdd(url, options({ skills: ["demo-skill"], yes: true }), box.context(ui.ui))).toBe(0);
    expect(ui.text()).toContain("overwrites: ./.claude/skills/demo-skill\n");
  });

  it("leaves a project's own skills/ directory alone with -y and says why", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".claude"));
    mkdirSync(join(box.home, ".openclaw"));
    mkdirSync(join(box.cwd, "skills/demo-skill"), { recursive: true });
    writeFileSync(join(box.cwd, "skills/demo-skill/SKILL.md"), "mine");
    const ui = fakeUi();
    expect(await runAdd(url, options({ skills: ["demo-skill"], yes: true }), box.context(ui.ui))).toBe(1);
    expect(readFileSync(join(box.cwd, "skills/demo-skill/SKILL.md"), "utf8")).toBe("mine");
    expect(ui.text()).not.toContain("overwrites: ./skills");
    expect(ui.text()).toContain("✗ demo-skill → OpenClaw: ./skills/demo-skill already exists and is not a link");
    expect(lstatSync(join(box.cwd, ".claude/skills/demo-skill")).isSymbolicLink()).toBe(true);
  });

  it("shows where a directory that leads out of the project really is before asking", async () => {
    const box = sandbox();
    const outside = tempDir();
    mkdirSync(join(box.cwd, ".claude"));
    symlinkSync(outside, join(box.cwd, ".claude/skills"));
    const ui = fakeUi({ agents: ["claude-code"], scope: false, confirm: true });
    expect(await runAdd(url, options({ skills: ["demo-skill"] }), box.context(ui.ui))).toBe(0);
    expect(ui.text()).toContain(`outside the project: ./.claude/skills/demo-skill → ${join(outside, "demo-skill")}`);
    expect(lstatSync(join(outside, "demo-skill")).isSymbolicLink()).toBe(true);
  });

  it("copies with --copy and says where", async () => {
    const box = sandbox();
    const ui = fakeUi();
    const code = await runAdd(url, options({ skills: ["demo-skill"], agents: ["claude-code", "cursor"], copy: true, yes: true }), box.context(ui.ui));
    expect(code).toBe(0);
    expect(lstatSync(join(box.cwd, ".claude/skills/demo-skill")).isDirectory()).toBe(true);
    expect(ui.text()).toContain("✓ demo-skill (copied)\n  → ./.claude/skills/demo-skill\n  → ./.agents/skills/demo-skill");
  });

  it("warns about entries it skipped and installs the rest", async () => {
    const box = sandbox();
    publishIndex(registry, "/warned", [{ name: "demo-skill", zip: skillZip("demo-skill") }], {
      overrides: [{ name: "far-skill", description: "Far.", type: "archive", url: "https://far.example/x.zip", digest: `sha256:${"0".repeat(64)}` }],
    });
    const ui = fakeUi();
    expect(await runAdd(`${registry.origin}/warned`, options({ yes: true }), box.context(ui.ui))).toBe(0);
    expect(ui.text()).toContain("warn: Skipped index entry far-skill: url points to another origin");
  });

  it("exits 1 and lists the failure when an agent directory cannot be written", async () => {
    const box = sandbox();
    mkdirSync(join(box.cwd, ".claude"));
    writeFileSync(join(box.cwd, ".claude/skills"), "not a directory");
    const ui = fakeUi();
    expect(await runAdd(url, options({ skills: ["demo-skill"], agents: ["claude-code"], yes: true }), box.context(ui.ui))).toBe(1);
    expect(ui.text()).toContain("error: Failed to install 1");
    expect(ui.text()).toContain("✗ demo-skill → Claude Code:");
  });
});

describe("runAdd with credentials", () => {
  const secret = () => `${registry.origin}/p/secret`;
  const host = () => new URL(registry.origin).host;
  const sentAuth = (prefix: string) => registry.log.filter((entry) => entry.path.startsWith(prefix)).map((entry) => entry.headers.authorization);
  const signedIn = (home: string, token = LOGIN_TOKEN) =>
    saveLogin({ home, env: {} }, registry.origin, { user: "alice", projects: ["secret"], token, createdAt: "2026-10-07T00:00:00.000Z" });

  it("installs private skills with a saved sign-in", async () => {
    const box = sandbox();
    signedIn(box.home);
    registry.log.length = 0;
    const ui = fakeUi();
    expect(await runAdd(secret(), options({ yes: true }), box.context(ui.ui))).toBe(0);
    expect(existsSync(join(box.cwd, ".agents/skills/secret-skill/SKILL.md"))).toBe(true);
    expect(sentAuth("/p/secret")).toEqual([`Bearer ${LOGIN_TOKEN}`, `Bearer ${LOGIN_TOKEN}`]);
    expect(ui.text()).not.toContain(LOGIN_TOKEN);
    expect(filesContaining(box.cwd, LOGIN_TOKEN)).toEqual([]);
  });

  it("installs private skills with an install key bound to this registry and writes no credentials", async () => {
    const box = sandbox({ SKILLSGIST_INSTALL_KEY: INSTALL_KEY, SKILLSGIST_HOST: registry.origin });
    registry.log.length = 0;
    const ui = fakeUi();
    expect(await runAdd(secret(), options({ yes: true }), box.context(ui.ui))).toBe(0);
    expect(sentAuth("/p/secret")).toEqual([`Bearer ${INSTALL_KEY}`, `Bearer ${INSTALL_KEY}`]);
    expect(existsSync(join(box.home, ".config"))).toBe(false);
    expect(ui.text()).not.toContain(INSTALL_KEY);
  });

  it("does not send an install key bound to another registry", async () => {
    const box = sandbox({ SKILLSGIST_INSTALL_KEY: INSTALL_KEY, SKILLSGIST_HOST: "https://elsewhere.example" });
    registry.log.length = 0;
    const ui = fakeUi();
    await expect(runAdd(secret(), options({ yes: true }), box.context(ui.ui))).rejects.toThrow(
      `No skills found at ${secret()}. If they are private, sign in first (npx skillsgist login ${secret()})`,
    );
    expect(ui.text()).toContain(`warn: SKILLSGIST_HOST is https://elsewhere.example, not ${registry.origin}; not sending SKILLSGIST_INSTALL_KEY`);
    expect(sentAuth("/p/secret").every((value) => value === undefined)).toBe(true);
  });

  it("tells anonymous readers of a project how to see its private skills", async () => {
    const box = sandbox();
    const ui = fakeUi();
    expect(await runAdd(url, options({ yes: true, skills: ["demo-skill"] }), box.context(ui.ui))).toBe(0);
    expect(ui.text()).toContain(`Public skills only. To include private ones, run: npx skillsgist login ${url}`);
  });

  it("offers to sign in when a project shows no public skills, then installs", async () => {
    const auth = installFakeAuth(registry, { projects: ["secret"] });
    const box = sandbox();
    const ui = fakeUi({ confirm: true, agents: ["claude-code"], scope: false });
    const context = { ...box.context(ui.ui), fetch: { sleep: async () => undefined }, openBrowser: () => undefined, hostname: "laptop" };
    expect(await runAdd(secret(), options(), context)).toBe(0);
    expect(ui.asked[0]).toBe("confirm");
    expect(auth.deviceRequests[0].get("scope")).toBe("project:secret");
    expect(existsSync(join(box.cwd, ".agents/skills/secret-skill/SKILL.md"))).toBe(true);
  });

  it("fails at once with the sign-in command inside an agent", async () => {
    const box = sandbox({ CLAUDECODE: "1" }, false);
    const ui = fakeUi();
    await expect(runAdd(secret(), options(), box.context(ui.ui))).rejects.toThrow(`npx skillsgist login ${secret()}`);
    expect(ui.asked).toEqual([]);
  });

  it("explains a sign-in the registry no longer accepts", async () => {
    const box = sandbox();
    signedIn(box.home, "sgd_revoked0000000000");
    await expect(runAdd(secret(), options({ yes: true }), box.context(fakeUi().ui))).rejects.toThrow(
      `Your sign-in to ${host()} has expired or was revoked. Run: npx skillsgist login ${secret()}`,
    );
  });

  it("explains an install key the registry rejects", async () => {
    const box = sandbox({ SKILLSGIST_INSTALL_KEY: "sgi_reset000000000000", SKILLSGIST_HOST: registry.origin });
    await expect(runAdd(secret(), options({ yes: true }), box.context(fakeUi().ui))).rejects.toThrow(
      `SKILLSGIST_INSTALL_KEY was rejected by ${host()}: it was reset or revoked`,
    );
  });

  it("explains an install key for another project", async () => {
    registry.routes.set("/p/locked/.well-known/agent-skills/index.json", {
      status: 403,
      type: "application/json",
      body: JSON.stringify({ error: "wrong_project", project: "other" }),
    });
    const box = sandbox({ SKILLSGIST_INSTALL_KEY: INSTALL_KEY, SKILLSGIST_HOST: registry.origin });
    await expect(runAdd(`${registry.origin}/p/locked`, options({ yes: true }), box.context(fakeUi().ui))).rejects.toThrow(
      "SKILLSGIST_INSTALL_KEY is for project other, not locked",
    );
  });

  it("explains a sign-in that does not cover the project", async () => {
    registry.routes.set("/p/locked/.well-known/agent-skills/index.json", {
      status: 403,
      type: "application/json",
      body: JSON.stringify({ error: "project_not_granted", project: "locked" }),
    });
    const box = sandbox();
    signedIn(box.home);
    await expect(runAdd(`${registry.origin}/p/locked`, options({ yes: true }), box.context(fakeUi().ui))).rejects.toThrow(
      `Your sign-in to ${host()} does not cover project locked. Run: npx skillsgist login ${registry.origin}/p/locked`,
    );
  });

  it("keeps installing public skills when the credentials file is broken", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".config/skillsgist"), { recursive: true });
    writeFileSync(join(box.home, ".config/skillsgist/credentials.json"), "{");
    const ui = fakeUi();
    expect(await runAdd(url, options({ yes: true, skills: ["demo-skill"] }), box.context(ui.ui))).toBe(0);
    expect(ui.text()).toContain("credentials.json is not valid JSON. Delete it and sign in again. Continuing without signing in.");
  });
});
