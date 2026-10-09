import { afterEach, describe, expect, it } from "vitest";
import { authHeaders, hostOrigin, resolveCredential } from "../src/auth.js";
import { saveLogin } from "../src/credentials.js";
import { redact } from "../src/source.js";
import { cleanup, tempDir } from "./helpers/fs.js";
import { INSTALL_KEY, LOGIN_TOKEN } from "./helpers/registry.js";

afterEach(cleanup);

const ORIGIN = "https://skills.example.com";

function setup(env: NodeJS.ProcessEnv) {
  const warnings: string[] = [];
  return { warnings, context: { home: tempDir(), env, platform: "linux" as const, warn: (message: string) => warnings.push(message) } };
}

const saved = { user: "alice", projects: ["team"], token: LOGIN_TOKEN, createdAt: "2026-10-07T00:00:00.000Z" };

describe("hostOrigin", () => {
  it.each([
    ["https://skills.example.com", ORIGIN],
    ["skills.example.com", ORIGIN],
    ["https://Skills.Example.com:443/p/team/", ORIGIN],
    [" https://skills.example.com/ ", ORIGIN],
    ["http://localhost:8787", "http://localhost:8787"],
  ])("reads %j as %s", (value, origin) => {
    expect(hostOrigin(value)).toBe(origin);
  });

  it.each(["", "http://skills.example.com", "ftp://skills.example.com", "https://", "not a host"])("refuses %j", (value) => {
    expect(hostOrigin(value)).toBeNull();
  });
});

describe("resolveCredential", () => {
  it("is anonymous with nothing configured", () => {
    expect(resolveCredential(ORIGIN, setup({}).context)).toEqual({ kind: "none" });
  });

  it("uses the install key when SKILLSGIST_HOST names this registry", () => {
    const { context, warnings } = setup({ SKILLSGIST_INSTALL_KEY: ` ${INSTALL_KEY}\n`, SKILLSGIST_HOST: "skills.example.com" });
    expect(resolveCredential(ORIGIN, context)).toEqual({ kind: "env", token: INSTALL_KEY });
    expect(warnings).toEqual([]);
  });

  it.each([
    [{ SKILLSGIST_HOST: "https://skills.example.com:8443" }, `SKILLSGIST_HOST does not name ${ORIGIN}`],
    [{ SKILLSGIST_HOST: "https://evil.example" }, `SKILLSGIST_HOST does not name ${ORIGIN}`],
    [{ SKILLSGIST_HOST: "http://skills.example.com" }, "SKILLSGIST_HOST is not an https address"],
    [{}, "SKILLSGIST_HOST is not set, so the install key is not bound to any registry"],
  ])("does not send the install key with %j", (env, why) => {
    const { context, warnings } = setup({ SKILLSGIST_INSTALL_KEY: INSTALL_KEY, ...env });
    expect(resolveCredential(ORIGIN, context)).toEqual({ kind: "none" });
    expect(warnings).toEqual([`${why}; not sending SKILLSGIST_INSTALL_KEY`]);
  });

  it("warns without leaking either variable when SKILLSGIST_HOST and SKILLSGIST_INSTALL_KEY are swapped", () => {
    const { context, warnings } = setup({ SKILLSGIST_INSTALL_KEY: "https://skills.example.com", SKILLSGIST_HOST: "sgi_0123456789abcdef" });
    expect(resolveCredential(ORIGIN, context)).toEqual({ kind: "none" });
    expect(warnings).toEqual([
      "SKILLSGIST_INSTALL_KEY holds an address, not an install key (are SKILLSGIST_HOST and SKILLSGIST_INSTALL_KEY swapped?); not sending SKILLSGIST_INSTALL_KEY",
    ]);
    expect(redact("https://skills.example.com")).toBe("https://skills.example.com");
  });

  it.each([
    ["sgt_0123456789abcdef", "holds a publish API token"],
    ["sgd_0123456789abcdef", "holds a sign-in token"],
    ["sgi_0123 456789abcdef", "has spaces or characters a header cannot carry"],
  ])("never sends %j as an install key", (key, why) => {
    const { context, warnings } = setup({ SKILLSGIST_INSTALL_KEY: key, SKILLSGIST_HOST: ORIGIN });
    expect(resolveCredential(ORIGIN, context)).toEqual({ kind: "none" });
    expect(warnings[0]).toContain(why);
  });

  it("never sends an install key too long for a header", () => {
    const { context, warnings } = setup({ SKILLSGIST_INSTALL_KEY: `sgi_${"0".repeat(4096)}`, SKILLSGIST_HOST: ORIGIN });
    expect(resolveCredential(ORIGIN, context)).toEqual({ kind: "none" });
    expect(warnings[0]).toContain("or is too long");
  });

  it("uses the saved sign-in of this registry when no install key is set", () => {
    const { context } = setup({});
    saveLogin(context, ORIGIN, saved);
    expect(resolveCredential(ORIGIN, context)).toEqual({ kind: "login", token: LOGIN_TOKEN });
    expect(resolveCredential("https://other.example", context)).toEqual({ kind: "none" });
  });

  it("prefers the install key over a saved sign-in", () => {
    const { context } = setup({ SKILLSGIST_INSTALL_KEY: INSTALL_KEY, SKILLSGIST_HOST: ORIGIN });
    saveLogin(context, ORIGIN, saved);
    expect(resolveCredential(ORIGIN, context)).toEqual({ kind: "env", token: INSTALL_KEY });
  });

  it("masks an install key without a prefix once it has been read", () => {
    const { context } = setup({ SKILLSGIST_INSTALL_KEY: "0123456789abcdef0123", SKILLSGIST_HOST: ORIGIN });
    resolveCredential(ORIGIN, context);
    expect(redact("key 0123456789abcdef0123")).toBe("key 0123…");
  });
});

describe("authHeaders", () => {
  it("sends a bearer token only when there is a credential", () => {
    expect(authHeaders({ kind: "none" })).toEqual({});
    expect(authHeaders({ kind: "env", token: INSTALL_KEY })).toEqual({ authorization: `Bearer ${INSTALL_KEY}` });
  });
});
