import { describe, expect, it } from "vitest";
import { maskKey, parseSource, redact } from "../src/source.js";

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
      key: null,
      display: "https://skills.example.com",
    });
  });

  it("keeps a project path and drops a trailing slash, query and fragment", () => {
    expect(parseSource("https://skills.example.com/p/team/?x=1#top")).toMatchObject({
      base: "/p/team",
      key: null,
      display: "https://skills.example.com/p/team",
    });
  });

  it("extracts the install key and masks it in the display form", () => {
    expect(parseSource(`https://skills.example.com/i/${KEY}/`)).toEqual({
      origin: "https://skills.example.com",
      base: `/i/${KEY}`,
      key: KEY,
      display: "https://skills.example.com/i/0123…",
    });
  });

  it("keeps the single-skill path under a key", () => {
    const source = parseSource(`https://skills.example.com/i/${KEY}/.well-known/agent-skills/demo-skill`);
    expect(source.base).toBe(`/i/${KEY}/.well-known/agent-skills/demo-skill`);
    expect(source.display).toBe("https://skills.example.com/i/0123…/.well-known/agent-skills/demo-skill");
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
  it("masks a parsed key wherever it appears", () => {
    parseSource(`https://skills.example.com/i/${KEY}`);
    expect(redact(`boom ${KEY} boom`)).toBe("boom 0123… boom");
  });

  it("masks any /i/ segment even when no key was parsed", () => {
    expect(redact(`https://h.example/i/${OTHER}/d/x/1.zip`)).toBe("https://h.example/i/fedc…/d/x/1.zip");
  });

  it.each([`skills.example.com/i/${OTHER}`, `localhost:8787/i/${OTHER}`, `"https://h.example/i/${OTHER}"`, `(http://[::1]:8080/i/${OTHER})`])(
    "masks the key in %s",
    (text) => {
      expect(redact(text)).not.toContain(OTHER);
      expect(redact(text)).toContain("/i/fedc…");
    },
  );

  it.each([
    "✓ /srv/i/project/.claude/skills/demo",
    "✓ ~/i/skillsgist-work/.agents/skills/demo",
    "EACCES: permission denied, mkdir '/Users/me/i/skillsgist-work/.claude'",
    'demo: the archive has unsafe path "a/i/skillsgist-work"',
  ])("leaves the path in %s alone", (text) => {
    expect(redact(text)).toBe(text);
  });

  it("is idempotent", () => {
    const once = redact(`https://h.example/i/${OTHER}`);
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
