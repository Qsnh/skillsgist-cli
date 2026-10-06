import { describe, expect, it, vi } from "vitest";
import type { SkillEntry } from "../src/registry.js";
import { parseSource } from "../src/source.js";

const multiselect = vi.hoisted(() => vi.fn());
const message = vi.hoisted(() => vi.fn());
const error = vi.hoisted(() => vi.fn());

vi.mock("@clack/prompts", () => ({ multiselect, log: { message, error }, isCancel: () => false }));

const { clackUi } = await import("../src/ui.js");

const KEY = "0123456789abcdef0123456789abcdef";

const skill = (description: string): SkillEntry => ({
  name: "demo-skill",
  description,
  url: "https://skills.example.com/d/demo-skill.zip",
  digest: `sha256:${"0".repeat(64)}`,
});

describe("clackUi", () => {
  it("masks a key in a skill's hint even where the hint is cut short", async () => {
    multiselect.mockResolvedValue(["demo-skill"]);
    await clackUi().selectSkills([skill(`${"x".repeat(20)} https://h.example/i/${KEY}/.well-known/agent-skills/demo-skill`)]);
    const hint: string = multiselect.mock.calls[0][0].options[0].hint;
    expect(hint).toContain("/i/0123…");
    expect(hint).not.toContain(KEY.slice(0, 5));
  });

  it("cuts a long hint between characters, not inside one", async () => {
    multiselect.mockResolvedValue(["demo-skill"]);
    await clackUi().selectSkills([skill(`${"x".repeat(56)}😀${"y".repeat(10)}`)]);
    const hint: string = multiselect.mock.lastCall![0].options[0].hint;
    expect(hint).toBe(`${"x".repeat(56)}😀…`);
  });

  it("writes errors to stderr", () => {
    clackUi().error("boom");
    expect(error).toHaveBeenCalledWith("boom", { output: process.stderr });
  });

  it("strips terminal escapes from what it prints but keeps line breaks", () => {
    clackUi().message("demo-skill\n  \x1b[2K\x1b[1A\x1b]52;c;ZXZpbA==\x07fake\u009b\u202e");
    expect(message).toHaveBeenCalledWith("demo-skill\n  [2K[1A]52;c;ZXZpbA==fake");
  });

  it("masks a key that a control character split in two", () => {
    parseSource(`https://h.example/i/${KEY}`);
    clackUi().message(`boom ${KEY.slice(0, 10)}\x1b${KEY.slice(10)} boom`);
    expect(message).toHaveBeenLastCalledWith("boom 0123… boom");
  });
});
