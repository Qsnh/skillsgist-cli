import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ui } from "../src/add.js";
import { browserCommand } from "../src/browser.js";
import { getLogin, saveLogin } from "../src/credentials.js";
import { runLogin, runLogout, runWhoami, type AccountContext } from "../src/login.js";
import { cleanup, tempDir } from "./helpers/fs.js";
import { installFakeAuth } from "./helpers/oauth.js";
import { INSTALL_KEY, LOGIN_TOKEN, LOGIN_TOKEN_2, startRegistry, type TestRegistry } from "./helpers/registry.js";

function quietUi() {
  const lines: string[] = [];
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected prompt");
  };
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
    selectSkills: unexpected,
    selectAgents: unexpected,
    selectScope: unexpected,
    selectInstalled: unexpected,
    confirm: unexpected,
  };
  return { ui, text: () => lines.join("\n") };
}

let registry: TestRegistry;

beforeAll(async () => {
  registry = await startRegistry();
});

afterAll(() => registry.close());

beforeEach(() => {
  registry.routes.clear();
  registry.log.length = 0;
});

afterEach(cleanup);

function account(overrides: Partial<AccountContext> = {}) {
  const ui = quietUi();
  const opened: string[] = [];
  const home = tempDir();
  const context: AccountContext = {
    ui: ui.ui,
    home,
    cwd: tempDir(),
    env: {},
    interactive: true,
    exists: () => false,
    platform: "linux",
    hostname: "laptop",
    openBrowser: (url) => opened.push(url),
    fetch: { sleep: async () => undefined },
    ...overrides,
  };
  return { context, ui, opened, file: join(home, ".config/skillsgist/credentials.json") };
}

const host = () => new URL(registry.origin).host;
const saved = (token: string) => ({ user: "alice", projects: [], token, createdAt: "2026-10-07T00:00:00.000Z" });

describe("runLogin", () => {
  it("signs in, saves the sign-in for this registry only, and opens the browser", async () => {
    const auth = installFakeAuth(registry, { projects: ["team"] });
    const box = account();
    expect(await runLogin(`${registry.origin}/p/team`, { browser: true }, box.context)).toBe(0);
    expect(box.opened).toEqual([`${registry.origin}/device?code=BCDF-GHJK`]);
    expect(box.ui.text()).toContain(`Open ${registry.origin}/device?code=BCDF-GHJK`);
    expect(box.ui.text()).toContain("shows the code BCDF-GHJK");
    expect(box.ui.text()).toContain(`Signed in to ${host()} as alice (projects: team)`);
    expect(Object.fromEntries(auth.deviceRequests[0])).toEqual({ client_id: "skillsgist-cli", device_name: "laptop", scope: "project:team" });
    expect(getLogin(box.context, registry.origin)).toMatchObject({ user: "alice", projects: ["team"], token: LOGIN_TOKEN });
    expect(statSync(box.file).mode & 0o777).toBe(0o600);
    expect(box.ui.text()).not.toContain(LOGIN_TOKEN);
  });

  it.each([
    ["with --no-browser", { browser: false }, {}],
    ["without a terminal", { browser: true }, { interactive: false }],
    ["inside an agent", { browser: true }, { env: { CLAUDECODE: "1" } }],
  ])("prints the link but opens no browser %s", async (_, options, overrides) => {
    installFakeAuth(registry);
    const box = account(overrides);
    expect(await runLogin(registry.origin, options, box.context)).toBe(0);
    expect(box.opened).toEqual([]);
    expect(box.ui.text()).toContain(`${registry.origin}/device?code=BCDF-GHJK`);
  });

  it("pre-ticks the projects of the last sign-in, then revokes the token it replaces", async () => {
    const auth = installFakeAuth(registry, { projects: ["team", "docs"] });
    const box = account();
    await runLogin(`${registry.origin}/p/team`, { browser: false }, box.context);
    await runLogin(`${registry.origin}/p/docs`, { browser: false }, box.context);
    expect(auth.deviceRequests[1].get("scope")).toBe("project:docs project:team");
    expect(getLogin(box.context, registry.origin)?.token).toBe(LOGIN_TOKEN_2);
    expect(auth.revoked).toEqual([LOGIN_TOKEN]);
  });

  it("keeps the new sign-in when the old one cannot be revoked", async () => {
    installFakeAuth(registry, { revokeStatus: 500 });
    const box = account();
    await runLogin(registry.origin, { browser: false }, box.context);
    await runLogin(registry.origin, { browser: false }, box.context);
    expect(getLogin(box.context, registry.origin)?.token).toBe(LOGIN_TOKEN_2);
    expect(box.ui.text()).toContain("warn: Could not revoke this computer's previous sign-in");
  });

  it("saves nothing when the browser denies the sign-in", async () => {
    installFakeAuth(registry, { outcome: "deny" });
    const box = account();
    await expect(runLogin(registry.origin, { browser: false }, box.context)).rejects.toThrow("Sign-in was denied in the browser");
    expect(existsSync(box.file)).toBe(false);
  });

  it("refuses an install-key address before contacting the registry", async () => {
    const box = account();
    await expect(runLogin(`${registry.origin}/i/0123456789abcdef0123456789abcdef`, { browser: true }, box.context)).rejects.toThrow(
      "Install keys no longer go in the URL",
    );
    expect(registry.log).toEqual([]);
  });
});

describe("runLogout", () => {
  it("revokes the sign-in and deletes it", async () => {
    const auth = installFakeAuth(registry);
    const box = account();
    await runLogin(registry.origin, { browser: false }, box.context);
    expect(await runLogout(null, box.context)).toBe(0);
    expect(auth.revoked).toEqual([LOGIN_TOKEN]);
    expect(existsSync(box.file)).toBe(false);
    expect(box.ui.text()).toContain(`Signed out of ${host()}`);
  });

  it("still deletes the sign-in when the registry cannot be reached", async () => {
    const box = account();
    const closed = await startRegistry();
    await closed.close();
    saveLogin(box.context, closed.origin, saved(LOGIN_TOKEN));
    expect(await runLogout(closed.origin, box.context)).toBe(0);
    expect(existsSync(box.file)).toBe(false);
    expect(box.ui.text()).toContain(`warn: Could not revoke the sign-in on ${new URL(closed.origin).host}`);
    expect(box.ui.text()).not.toContain(LOGIN_TOKEN);
  });

  it("asks which registry when signed in to several", async () => {
    const box = account();
    saveLogin(box.context, "https://a.example", saved(LOGIN_TOKEN));
    saveLogin(box.context, "https://b.example", saved(LOGIN_TOKEN_2));
    await expect(runLogout(null, box.context)).rejects.toThrow(
      "Signed in to 2 registries (https://a.example, https://b.example). Name one: skillsgist logout <url>",
    );
  });

  it("says so when not signed in", async () => {
    const box = account();
    expect(await runLogout(null, box.context)).toBe(0);
    expect(box.ui.text()).toContain("Not signed in anywhere");
  });

  it("reminds that an install key in the environment still applies", async () => {
    const box = account({ env: { SKILLSGIST_INSTALL_KEY: INSTALL_KEY, SKILLSGIST_HOST: registry.origin } });
    expect(await runLogout(registry.origin, box.context)).toBe(0);
    expect(box.ui.text()).toContain("SKILLSGIST_INSTALL_KEY is still set for this registry; logout does not change it");
  });
});

describe("runWhoami", () => {
  it("shows the account and projects of a sign-in and of an install key", async () => {
    installFakeAuth(registry, { projects: ["team"], installKeys: { [INSTALL_KEY]: "ci" } });
    const box = account();
    await runLogin(registry.origin, { browser: false }, box.context);
    expect(await runWhoami(null, box.context)).toBe(0);
    expect(box.ui.text()).toContain(`${registry.origin}: alice via sign-in (projects: team)`);
    const ci = account({ env: { SKILLSGIST_INSTALL_KEY: INSTALL_KEY, SKILLSGIST_HOST: registry.origin } });
    expect(await runWhoami(null, ci.context)).toBe(0);
    expect(ci.ui.text()).toContain(`${registry.origin}: alice via SKILLSGIST_INSTALL_KEY (projects: ci)`);
  });

  it("fails for a sign-in the registry no longer accepts", async () => {
    installFakeAuth(registry);
    const box = account();
    saveLogin(box.context, registry.origin, saved("sgd_revoked0000000000"));
    expect(await runWhoami(registry.origin, box.context)).toBe(1);
    expect(box.ui.text()).toContain(`${registry.origin}: the sign-in has expired or was revoked`);
  });

  it("fails when not signed in anywhere", async () => {
    const box = account();
    expect(await runWhoami(null, box.context)).toBe(1);
    expect(box.ui.text()).toContain("Not signed in. Run: npx skillsgist login <url>");
  });
});

describe("browserCommand", () => {
  it.each([
    ["darwin", "open"],
    ["win32", "explorer.exe"],
    ["linux", "xdg-open"],
  ] as const)("uses the %s opener", (platform, command) => {
    expect(browserCommand("https://h.example/device", platform)).toEqual([command, ["https://h.example/device"]]);
  });
});
