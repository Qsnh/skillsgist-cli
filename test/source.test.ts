import { describe, expect, it } from "vitest";
import { keyInUrl, maskKey, parseSource, redact, registerSecret } from "../src/source.js";

const KEY = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

function failure(action: () => unknown): string {
  try {
    action();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a failure");
}

describe("parseSource", () => {
  it("reads the origin and an empty base from a bare origin", () => {
    expect(parseSource("https://skills.example.com")).toEqual({
      origin: "https://skills.example.com",
      base: "",
      project: null,
      display: "https://skills.example.com",
    });
  });

  it("keeps a project path, reads the project, and drops a trailing slash, query and fragment", () => {
    expect(parseSource("https://skills.example.com/p/team/?x=1#top")).toEqual({
      origin: "https://skills.example.com",
      base: "/p/team",
      project: "team",
      display: "https://skills.example.com/p/team",
    });
  });

  it("reads the project of a single-skill address", () => {
    const source = parseSource("https://skills.example.com/p/team/.well-known/agent-skills/demo-skill");
    expect(source.project).toBe("team");
    expect(source.base).toBe("/p/team/.well-known/agent-skills/demo-skill");
  });

  it("decodes an escaped project name", () => {
    expect(parseSource("https://skills.example.com/p/my%2Dteam").project).toBe("my-team");
  });

  it("has no project for a path that is not /p/<project>", () => {
    expect(parseSource("https://skills.example.com/team").project).toBeNull();
    expect(parseSource("https://skills.example.com/p").project).toBeNull();
  });

  it.each([
    `https://skills.example.com/i/${KEY}`,
    `https://skills.example.com//i/${KEY}/`,
    `https://skills.example.com/i//${KEY}`,
    `https://skills.example.com/%69/${KEY}/.well-known/agent-skills/demo-skill`,
  ])("refuses the install-key address %s without echoing the key", (url) => {
    const message = failure(() => parseSource(url));
    expect(message).toBe(keyInUrl("https://skills.example.com"));
    expect(message).not.toContain(KEY);
  });

  it("says where to go instead of an install-key address", () => {
    expect(keyInUrl("https://skills.example.com")).toBe(
      "Install keys no longer go in the URL. Use the address on the project page (https://skills.example.com/p/<project>) and sign in with: npx skillsgist login https://skills.example.com. In CI, set SKILLSGIST_HOST and SKILLSGIST_INSTALL_KEY instead.",
    );
  });

  it("collapses repeated slashes in the base", () => {
    expect(parseSource("https://skills.example.com//p//team//").base).toBe("/p/team");
  });

  it.each(["http://localhost:8787", "http://127.0.0.1:8787/p/team", "http://[::1]:8080"])(
    "accepts plain http to the loopback address %s",
    (url) => {
      expect(() => parseSource(url)).not.toThrow();
    },
  );

  it("refuses plain http to any other host without echoing the key", () => {
    const message = failure(() => parseSource(`http://skills.example.com/i/${KEY}`));
    expect(message).toMatch(/use https/);
    expect(message).not.toContain(KEY);
  });

  it("refuses other schemes", () => {
    expect(failure(() => parseSource("ftp://skills.example.com"))).toMatch(/Unsupported URL scheme ftp:/);
  });

  it("refuses a username or password in the URL", () => {
    expect(failure(() => parseSource("https://user:pass@skills.example.com"))).toMatch(/username or password/);
  });

  it("masks a key inside an input that is not a URL", () => {
    const message = failure(() => parseSource(`skills.example.com/i/${OTHER}`));
    expect(message).toMatch(/Not a valid URL/);
    expect(message).not.toContain(OTHER);
  });
});

describe("redact", () => {
  it("masks a registered secret wherever it appears", () => {
    registerSecret(KEY);
    expect(redact(`boom ${KEY} boom`)).toBe("boom 0123… boom");
  });

  it("does not register a secret too short to mask safely", () => {
    registerSecret("abc");
    expect(redact("abcdef")).toBe("abcdef");
  });

  it.each([
    ["sgd_fedcba9876543210", "sgd_…"],
    ["Authorization: Bearer sgi_0123456789abcdef", "Authorization: Bearer sgi_…"],
    ["token=sgt_AbC-dEf_0123", "token=sgt_…"],
  ])("masks the prefixed token in %s", (text, masked) => {
    expect(redact(text)).toBe(masked);
  });

  it.each(["sgd_short", "xsgd_0123456789abcdef", "my_sgd_0123456789abcdef"])("leaves %s alone", (text) => {
    expect(redact(text)).toBe(text);
  });

  it("masks any /i/ segment even when no key was registered", () => {
    expect(redact(`https://h.example/i/${OTHER}/d/x/1.zip`)).toBe("https://h.example/i/fedc…/d/x/1.zip");
  });

  it.each([
    `skills.example.com/i/${OTHER}`,
    `localhost:8787/i/${OTHER}`,
    `"https://h.example/i/${OTHER}"`,
    `(http://[::1]:8080/i/${OTHER})`,
    `skills.example.com//i/${OTHER}`,
    `https://h.example/i//${OTHER}`,
  ])("masks the key in %s", (text) => {
    expect(redact(text)).not.toContain(OTHER);
    expect(redact(text)).toMatch(/\/i\/+fedc…/);
  });

  it.each([
    "✓ /srv/i/project/.claude/skills/demo",
    "✓ ~/i/skillsgist-work/.agents/skills/demo",
    "EACCES: permission denied, mkdir '/Users/me/i/skillsgist-work/.claude'",
    'demo: the archive has unsafe path "a/i/skillsgist-work"',
  ])("leaves the path in %s alone", (text) => {
    expect(redact(text)).toBe(text);
  });

  it("is idempotent", () => {
    const once = redact(`https://h.example/i/${OTHER} sgd_0123456789abcdef`);
    expect(redact(once)).toBe(once);
  });
});

describe("maskKey", () => {
  it("keeps four characters of a long key", () => {
    expect(maskKey(KEY)).toBe("0123…");
  });

  it("hides a short key entirely", () => {
    expect(maskKey("abc")).toBe("…");
  });
});
