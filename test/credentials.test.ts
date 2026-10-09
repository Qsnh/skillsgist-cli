import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configDir, credentialsPath, deleteLogin, getLogin, readCredentials, saveLogin, type HostLogin } from "../src/credentials.js";
import { cleanup, tempDir } from "./helpers/fs.js";

afterEach(cleanup);

const ORIGIN = "https://skills.example.com";

const login = (overrides: Partial<HostLogin> = {}): HostLogin => ({
  user: "alice",
  projects: ["team"],
  token: "sgd_0123456789abcdef",
  createdAt: "2026-10-07T12:00:00.000Z",
  ...overrides,
});

function box(env: NodeJS.ProcessEnv = {}) {
  const home = tempDir();
  const warnings: string[] = [];
  const context = { home, env, platform: "linux" as const, warn: (message: string) => warnings.push(message) };
  return { home, warnings, context, dir: join(home, ".config/skillsgist"), file: join(home, ".config/skillsgist/credentials.json") };
}

describe("configDir", () => {
  it("prefers SKILLSGIST_CONFIG_DIR", () => {
    expect(configDir({ home: "/home/me", env: { SKILLSGIST_CONFIG_DIR: "/etc/sg", XDG_CONFIG_HOME: "/x" }, platform: "linux" })).toBe("/etc/sg");
  });

  it("uses XDG_CONFIG_HOME next", () => {
    expect(configDir({ home: "/home/me", env: { XDG_CONFIG_HOME: "/x" }, platform: "linux" })).toBe("/x/skillsgist");
  });

  it("falls back to ~/.config", () => {
    expect(configDir({ home: "/home/me", env: {}, platform: "darwin" })).toBe("/home/me/.config/skillsgist");
  });

  it("uses APPDATA on Windows", () => {
    expect(configDir({ home: "C:\\Users\\me", env: { APPDATA: "D:\\Roaming", XDG_CONFIG_HOME: "/x" }, platform: "win32" })).toBe("D:\\Roaming\\skillsgist");
    expect(configDir({ home: "C:\\Users\\me", env: {}, platform: "win32" })).toBe("C:\\Users\\me\\AppData\\Roaming\\skillsgist");
  });

  it("keeps credentials.json inside it", () => {
    expect(credentialsPath({ home: "/home/me", env: {}, platform: "linux" })).toBe("/home/me/.config/skillsgist/credentials.json");
  });
});

describe("sign-ins on disk", () => {
  it("reads nothing when there is no file", () => {
    const { context } = box();
    expect(readCredentials(context)).toEqual({ version: 1, hosts: {} });
    expect(getLogin(context, ORIGIN)).toBeNull();
  });

  it("saves a sign-in only you can read, in a private directory", () => {
    const { context, dir, file } = box();
    saveLogin(context, ORIGIN, login());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, hosts: { [ORIGIN]: login() } });
    expect(getLogin(context, ORIGIN)).toEqual(login());
  });

  it("uses SKILLSGIST_CONFIG_DIR when it is set", () => {
    const custom = join(tempDir(), "sg");
    const { context } = box({ SKILLSGIST_CONFIG_DIR: custom });
    saveLogin(context, ORIGIN, login());
    expect(existsSync(join(custom, "credentials.json"))).toBe(true);
  });

  it("replaces the sign-in of the same registry and keeps the others", () => {
    const { context } = box();
    saveLogin(context, ORIGIN, login());
    saveLogin(context, "http://localhost:8787", login({ user: "bob" }));
    saveLogin(context, ORIGIN, login({ token: "sgd_ffffffffffffffff" }));
    expect(getLogin(context, ORIGIN)?.token).toBe("sgd_ffffffffffffffff");
    expect(deleteLogin(context, ORIGIN)).toBe(true);
    expect(Object.keys(readCredentials(context).hosts)).toEqual(["http://localhost:8787"]);
  });

  it("deletes the file with the last sign-in and leaves no temporary files", () => {
    const { context, dir } = box();
    saveLogin(context, ORIGIN, login());
    expect(deleteLogin(context, ORIGIN)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    expect(deleteLogin(context, ORIGIN)).toBe(false);
  });

  it("tightens a file other users can read, and says so", () => {
    const { context, file, warnings } = box();
    saveLogin(context, ORIGIN, login());
    chmodSync(file, 0o644);
    expect(getLogin(context, ORIGIN)).toEqual(login());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(warnings).toEqual([`${file} was readable by other users; it is now readable only by you`]);
  });

  it.each([
    ["text that is not JSON", "{", "is not valid JSON"],
    ["no version", JSON.stringify({ hosts: {} }), "is not a skillsgist credentials file"],
    ["hosts as a list", JSON.stringify({ version: 1, hosts: [] }), "is not a skillsgist credentials file"],
    ["a host that is not an origin", JSON.stringify({ version: 1, hosts: { "https://h.example/path": login() } }), "has an entry skillsgist cannot read"],
    ["__proto__ as a host", `{"version":1,"hosts":{"__proto__":${JSON.stringify(login())}}}`, "has an entry skillsgist cannot read"],
    ["a token that is not a string", JSON.stringify({ version: 1, hosts: { [ORIGIN]: { ...login(), token: 5 } } }), "has an entry skillsgist cannot read"],
    [
      "a token too long for a header",
      JSON.stringify({ version: 1, hosts: { [ORIGIN]: { ...login(), token: `sgd_${"0".repeat(4096)}` } } }),
      "has an entry skillsgist cannot read",
    ],
    [
      "a token with a newline",
      JSON.stringify({ version: 1, hosts: { [ORIGIN]: { ...login(), token: "sgd_bad\ntoken0000" } } }),
      "has an entry skillsgist cannot read",
    ],
  ])("refuses a file with %s without printing its contents", (_, text, problem) => {
    const { context, dir, file } = box();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text, { mode: 0o600 });
    expect(() => readCredentials(context)).toThrow(`${file} ${problem}. Delete it and sign in again.`);
  });

  it("asks for an upgrade when a newer skillsgist wrote the file", () => {
    const { context, dir, file } = box();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 2, hosts: {} }), { mode: 0o600 });
    expect(() => readCredentials(context)).toThrow(`${file} was written by a newer skillsgist. Upgrade skillsgist, or delete the file and sign in again.`);
  });

  it.skipIf(process.getuid?.() === 0)("reports a file it cannot save and leaves no temporary file", () => {
    const { context, dir } = box();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    try {
      expect(() => saveLogin(context, ORIGIN, login())).toThrow(/^Could not save .*credentials\.json: /);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
