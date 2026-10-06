import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { hasNameAndDescription, isSafeArchivePath, unpackSkill } from "../src/archive.js";
import { skillMd } from "./helpers/registry.js";

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])));

function failure(action: () => unknown): string {
  try {
    action();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a failure");
}

describe("unpackSkill", () => {
  it("returns every file keyed by its path and skips directory entries", () => {
    const bytes = zipSync({
      "SKILL.md": strToU8(skillMd("demo-skill")),
      "references/": new Uint8Array(0),
      "references/api.md": strToU8("api"),
    });
    const files = unpackSkill("demo-skill", bytes);
    expect([...files.keys()].sort()).toEqual(["SKILL.md", "references/api.md"]);
    expect(new TextDecoder().decode(files.get("references/api.md"))).toBe("api");
  });

  it.each(["../evil.md", "a/../../evil.md", "/etc/evil", "C:/evil.md", "a\\evil.md", "./other.md"])(
    "rejects the unsafe path %s",
    (path) => {
      expect(failure(() => unpackSkill("demo-skill", zip({ "SKILL.md": skillMd("demo-skill"), [path]: "x" })))).toMatch(/unsafe path/);
    },
  );

  it("rejects more files than the limit", () => {
    const extra = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`f${i}.md`, "x"]));
    const bytes = zip({ "SKILL.md": skillMd("demo-skill"), ...extra });
    expect(failure(() => unpackSkill("demo-skill", bytes, { maxFiles: 3, maxBytes: 10_000 }))).toMatch(/more than 3 files/);
  });

  it("rejects more unpacked bytes than the limit", () => {
    const bytes = zip({ "SKILL.md": skillMd("demo-skill"), "big.md": "x".repeat(5000) });
    expect(failure(() => unpackSkill("demo-skill", bytes, { maxFiles: 10, maxBytes: 1000 }))).toMatch(/more than 1000 bytes/);
  });

  it("requires SKILL.md at the root, spelled exactly", () => {
    expect(failure(() => unpackSkill("demo-skill", zip({ "demo-skill/SKILL.md": skillMd("demo-skill") })))).toMatch(/no SKILL\.md at its root/);
    expect(failure(() => unpackSkill("demo-skill", zip({ "skill.md": skillMd("demo-skill") })))).toMatch(/no SKILL\.md at its root/);
  });

  it("requires a name and a description in the frontmatter", () => {
    expect(failure(() => unpackSkill("demo-skill", zip({ "SKILL.md": "---\nname: demo-skill\n---\n" })))).toMatch(/no name and description/);
  });

  it("rejects bytes that are not a zip", () => {
    expect(failure(() => unpackSkill("demo-skill", strToU8("not a zip")))).toBe("demo-skill: the archive cannot be unpacked: invalid zip data");
  });

  it("names the compression method it cannot read", () => {
    const bytes = zipSync({ "SKILL.md": strToU8(skillMd("demo-skill")) }, { level: 0 });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(8, 9, true);
    view.setUint16(view.getUint32(bytes.length - 6, true) + 10, 9, true);
    expect(failure(() => unpackSkill("demo-skill", bytes))).toBe("demo-skill: the archive cannot be unpacked: unknown compression type 9");
  });
});

describe("isSafeArchivePath", () => {
  it("accepts nested relative paths", () => {
    expect(isSafeArchivePath("references/deep/api.md")).toBe(true);
  });

  it("rejects an empty segment", () => {
    expect(isSafeArchivePath("a//b.md")).toBe(false);
  });
});

describe("hasNameAndDescription", () => {
  it("accepts a folded description", () => {
    expect(hasNameAndDescription("---\nname: x\ndescription: >-\n  folded\n---\n")).toBe(true);
  });

  it("accepts CRLF line endings and a byte order mark", () => {
    expect(hasNameAndDescription("\uFEFF---\r\nname: x\r\ndescription: y\r\n---\r\n")).toBe(true);
  });

  it("rejects a file without frontmatter", () => {
    expect(hasNameAndDescription("# x\n")).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(hasNameAndDescription("---\nname:\ndescription: y\n---\n")).toBe(false);
  });
});
